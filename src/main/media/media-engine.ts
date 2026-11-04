import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sharedTexture, type SharedTextureHandle, type WebContents } from "electron";
import { engineDir, enginePath } from "../paths";

/**
 * The media engine (`native/engine/engine.cpp`): ONE file per process, played by libmpv, which also
 * plays its sound. Each frame lands in a GPU texture of the engine's ring; this module imports it once
 * and sends it to every window that shows that file, so the projector and the LIVE monitor draw the
 * very same frame from a single decode. Plan: `2026-10-25-reproduccion-instantanea`, §6 «Contrato del
 * motor para el paso 1».
 *
 * A window only ever holds the latest frame: one still busy with the previous one skips the next,
 * so a window that stopped drawing (occluded, closing) costs its own frames, never the projector's.
 * `sendSharedTexture` also gives up by itself after 1000 ms.
 *
 * Starting a process costs 150–650 ms (measured 2026-10-29/30), so `takeEngine()` hands out one
 * started ahead of time and starts the next.
 */

export type EngineLoad = {
  file: string;
  startAtSeconds: number;
  paused: boolean;
  /** 0..1 */
  volume: number;
  loop: boolean;
  /** false: the audio is not even decoded (the PREVIEW monitor). */
  audio: boolean;
};
export type EngineLoaded = { duration: number; width: number; height: number; hasVideo: boolean; hasAudio: boolean };
export type EngineStatus = { time: number; duration: number; paused: boolean; ended: boolean };
/** `engine-open`: the file can't be played · `engine-gpu`: no device or no shared texture ·
 *  `engine-args`: a bug on this side · `engine-exit`: the process died. */
export type EngineError = { code: string; detail: string };

export type EngineEvents = {
  loaded?: (info: EngineLoaded) => void;
  status?: (status: EngineStatus) => void;
  error?: (error: EngineError) => void;
  exit?: () => void;
};

type EngineEvent =
  | { ev: "ready"; gpu: string }
  | ({ ev: "loaded" } & EngineLoaded)
  | { ev: "slots"; width: number; height: number; handles: (number | string | { stride: number; size: number })[] }
  | { ev: "frame"; slot: number }
  | ({ ev: "status" } & EngineStatus)
  | ({ ev: "error" } & EngineError);

/** `native/handles`: what Node can't do to take another process's textures. */
type MacHandles = { lookup(id: number): string; release(pointer: string): void };
type LinuxHandles = { listen(socketPath: string): number; accept(server: number, timeoutMs: number): number[]; close(fd: number): void };

let handlesAddon: MacHandles | LinuxHandles | null = null;
function handles<T extends MacHandles | LinuxHandles>(): T {
  if (!handlesAddon) {
    const mod = { exports: {} as MacHandles | LinuxHandles };
    process.dlopen(mod, path.join(engineDir, "handles.node"));
    handlesAddon = mod.exports;
  }
  return handlesAddon as T;
}

/** 0..1, as `HTMLMediaElement.volume` takes it (linear amplitude) → mpv's `volume`, which it cubes
 *  (`player/audio.c`): sent as it was, the panel's 30% played at 2.7% of full scale. */
function mpvVolume(volume: number): number {
  return Math.round(Math.cbrt(Math.min(1, Math.max(0, volume))) * 100);
}

/** A ring texture as `sharedTexture` imports it. */
function pointerBuffer(value: string): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

/** Windows: the textures of an engine that died are still open in this process; the next engine
 *  closes them (`--close-in-parent`), since Node has no CloseHandle. */
let orphanedWindowsHandles: string[] = [];
const running = new Set<MediaEngine>();
let spare: MediaEngine | null = null;

const STDERR_TAIL_BYTES = 4096;

let available: boolean | null = null;
/** Whether this build carries an engine for this machine. Asked once: the binary does not come and go. */
export function engineAvailable(): boolean {
  available ??= fs.existsSync(enginePath);
  return available;
}

/** An engine ready for `load()`, and the next one starting behind it. */
export function takeEngine(): MediaEngine {
  const engine = spare && !spare.exited ? spare : new MediaEngine();
  spare = new MediaEngine();
  return engine;
}

/** Starts the spare before the first file needs it. */
export function prewarmEngine(): void {
  if (!spare || spare.exited) spare = new MediaEngine();
}

/** Synchronous, for `before-quit`: `.claude/knowledge/nothing-asynchronous-survives-before-quit.md`. */
export function killAllEngines(): void {
  for (const engine of running) engine.kill();
  spare = null;
}

export class MediaEngine {
  exited = false;
  private readonly child: ChildProcess;
  private events: EngineEvents = {};
  private stdoutBuffer = "";
  private stderrTail = "";
  private socketPath: string | null = null;
  private server = -1;
  /** What each slot of the ring is imported from, once the engine has made it. */
  private ring: { width: number; height: number; handles: SharedTextureHandle[] } | null = null;
  private macPointers: string[] = [];
  private linuxFds: number[] = [];
  private windowsHandles: string[] = [];
  /** Where this engine's frames go, and which of them is still drawing the previous one. */
  private readonly targets = new Map<WebContents, { busy: boolean }>();
  private targetKey = "";
  private loadedOnce = false;
  private lastStatus: EngineStatus | null = null;

  constructor() {
    const args = ["--max-width", "1920", "--max-height", "1080"];
    if (process.platform === "win32") {
      args.push("--parent", String(process.pid));
      if (orphanedWindowsHandles.length) args.push("--close-in-parent", orphanedWindowsHandles.join(","));
      orphanedWindowsHandles = [];
    } else if (process.platform === "linux") {
      this.socketPath = path.join(os.tmpdir(), `lumina-engine-${process.pid}-${Date.now()}-${running.size}.sock`);
      this.server = handles<LinuxHandles>().listen(this.socketPath);
      args.push("--fd-socket", this.socketPath);
    }
    this.child = spawn(enginePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    running.add(this);
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", () => {
      // The engine is gone; `exit` says so.
    });
    this.child.once("error", (error) => this.fail({ code: "engine-exit", detail: error.message }));
    this.child.once("exit", (code, signal) => this.onExit(code, signal));
  }

  /** `target` is what the renderer listens for (`window.worship.onVideoFrame`): one engine, one key. */
  load(opts: EngineLoad, target: string, events: EngineEvents): void {
    if (this.loadedOnce) throw new Error("an engine plays one file");
    if (/[\r\n]/.test(opts.file)) throw new Error("a path with a line break");
    this.loadedOnce = true;
    this.targetKey = target;
    this.events = events;
    const volume = mpvVolume(opts.volume);
    const flag = (b: boolean) => (b ? "1" : "0");
    this.write(
      `load ${Math.max(0, opts.startAtSeconds)} ${flag(opts.paused)} ${volume} ${flag(opts.loop)} ${flag(opts.audio)} ${opts.file}`,
    );
  }

  show(contents: WebContents): void {
    if (!this.targets.has(contents)) this.targets.set(contents, { busy: false });
  }

  hide(contents: WebContents): void {
    this.targets.delete(contents);
  }

  setPaused(paused: boolean): void {
    this.write(`pause ${paused ? 1 : 0}`);
  }

  setVolume(volume: number): void {
    this.write(`volume ${mpvVolume(volume)}`);
  }

  setLoop(loop: boolean): void {
    this.write(`loop ${loop ? 1 : 0}`);
  }

  seek(toSeconds: number, exact = true): void {
    this.write(`seek ${Math.max(0, toSeconds)} ${exact ? "exact" : "keyframes"}`);
  }

  /** A paused engine sends no frames, so a window that starts showing it (a projector rebuilt, a
   *  monitor remounted) would stay black until play: seeking to where it stands draws that frame
   *  again, for every window. A playing one needs nothing. */
  redraw(): void {
    if (this.lastStatus?.paused) this.seek(this.lastStatus.time);
  }

  /** Asks it to finish; it closes its textures in this process on the way out (Windows). */
  quit(): void {
    this.write("quit");
    // A wedged engine must not outlive its file: it would keep playing sound.
    setTimeout(() => this.kill(), 2000).unref();
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private write(line: string): void {
    if (!this.exited && this.child.stdin?.writable) this.child.stdin.write(line + "\n");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: EngineEvent;
      try {
        event = JSON.parse(line) as EngineEvent;
      } catch {
        continue;
      }
      this.onEvent(event);
    }
  }

  private onEvent(event: EngineEvent): void {
    switch (event.ev) {
      case "ready":
        return;
      case "loaded":
        return this.events.loaded?.(event);
      case "slots":
        return this.onSlots(event);
      case "frame":
        return this.onFrame(event.slot);
      case "status":
        this.lastStatus = event;
        return this.events.status?.(event);
      case "error":
        return this.fail(event);
    }
  }

  private onSlots(event: Extract<EngineEvent, { ev: "slots" }>): void {
    try {
      let ringHandles: SharedTextureHandle[];
      if (process.platform === "darwin") {
        const mac = handles<MacHandles>();
        this.macPointers = event.handles.map((id) => mac.lookup(Number(id)));
        ringHandles = this.macPointers.map((p) => ({ ioSurface: pointerBuffer(p) }));
      } else if (process.platform === "linux") {
        // The engine sent the fds before this line, so the connection is already waiting.
        this.linuxFds = handles<LinuxHandles>().accept(this.server, 1000);
        if (this.linuxFds.length !== event.handles.length) throw new Error(`${this.linuxFds.length} buffers for ${event.handles.length} slots`);
        const fds = this.linuxFds;
        ringHandles = event.handles.map((plane, i) => {
          const { stride, size } = plane as { stride: number; size: number };
          const fd = fds[i] ?? -1;
          return { nativePixmap: { planes: [{ fd, offset: 0, stride, size }], modifier: "0", supportsZeroCopyWebGpuImport: false } };
        });
      } else {
        this.windowsHandles = event.handles.map(String);
        ringHandles = this.windowsHandles.map((h) => ({ ntHandle: pointerBuffer(h) }));
      }
      this.ring = { width: event.width, height: event.height, handles: ringHandles };
    } catch (error) {
      this.fail({ code: "engine-gpu", detail: error instanceof Error ? error.message : String(error) });
      this.kill();
    }
  }

  private onFrame(slot: number): void {
    const give = () => this.write(`release ${slot}`);
    const handle = this.ring?.handles[slot];
    for (const contents of this.targets.keys()) if (contents.isDestroyed()) this.targets.delete(contents);
    const ready = [...this.targets].filter(([, t]) => !t.busy);
    if (!this.ring || !handle || !ready.length) return give();
    const { width, height } = this.ring;
    let imported: Electron.SharedTextureImported;
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: "bgra", codedSize: { width, height }, handle },
        allReferencesReleased: give,
      });
    } catch (error) {
      this.fail({ code: "engine-gpu", detail: `import: ${error instanceof Error ? error.message : String(error)}` });
      return give();
    }
    let pending = ready.length;
    for (const [contents, t] of ready) {
      t.busy = true;
      sharedTexture
        .sendSharedTexture({ frame: contents.mainFrame, importedSharedTexture: imported }, this.targetKey)
        .catch(() => {
          // A window closing or not listening yet: its next frame is the next chance.
        })
        .finally(() => {
          t.busy = false;
          if (--pending === 0) imported.release();
        });
    }
  }

  private fail(error: EngineError): void {
    this.events.error?.(error);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    running.delete(this);
    if (spare === this) spare = null;
    // Electron holds its own reference to every texture it imported; these are ours.
    if (process.platform === "darwin") for (const p of this.macPointers) handles<MacHandles>().release(p);
    if (process.platform === "linux") {
      const linux = handles<LinuxHandles>();
      for (const fd of this.linuxFds) linux.close(fd);
      if (this.server >= 0) linux.close(this.server);
      if (this.socketPath) fs.rm(this.socketPath, { force: true }, () => {});
    }
    // A clean quit closed them from the engine; a crash left them open here.
    if (process.platform === "win32" && code !== 0) orphanedWindowsHandles.push(...this.windowsHandles);
    if (code !== 0 && this.loadedOnce)
      this.fail({ code: "engine-exit", detail: `exit ${signal ?? code}: ${this.stderrTail.trim().slice(-300)}` });
    this.events.exit?.();
  }
}
