import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, sharedTexture, type SharedTextureHandle, type WebContents } from "electron";
import { engineCacheDir, engineDir, enginePath } from "../paths";
import { broadcast } from "../services/broadcast";
import { getSettingsRepo } from "../services/repos";
import {
  AUDIO_DEVICE_PROTO,
  EngineGate,
  jsonLineReader,
  mpvVolume,
  SNIFF_BYTES,
  textInsteadOfMedia,
  type EngineDevice,
} from "./engine-protocol";

/**
 * The media engine (`native/engine/engine.cpp`): ONE file per process, played by libmpv, which also
 * plays its sound. Each frame lands in a GPU texture of the engine's ring; this module imports it once
 * and sends it to every window that shows that file, so the projector and the LIVE monitor draw the
 * very same frame from a single decode.
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
  /** false: the audio is not even decoded (a song theme's video background; PREVIEW sounds since 2026-11-05). */
  audio: boolean;
  /** mpv's name for the output it plays through (`EngineDevice.name`); absent, the system's default. An engine
   *  older than `AUDIO_DEVICE_PROTO` plays it on the default. */
  device?: string;
};
export type EngineLoaded = { duration: number; width: number; height: number; hasVideo: boolean; hasAudio: boolean };
export type EngineStatus = { time: number; duration: number; paused: boolean; ended: boolean };
/** The sound's sample peak per channel [left, right] in dBFS, −120 for none: what the file carries, before its
 *  volume, at the moment the room hears it; every 40 ms while it plays, one at −120 when it stops. */
export type EngineLevel = [number, number];
/** Whether the sound reaches the output `EngineLoad.device` / `setDevice` named (`device`, «auto» the system's): false
 *  when it could not be opened (the file plays on, unheard) or it left the system (the OS may play it elsewhere), true
 *  when it is back (the engine reopens a device that comes back by itself). Said on changes, never as an `error`. */
export type EngineAudioOut = { ok: boolean; device: string };
/** `engine-open`: the file can't be played · `engine-gpu`: no device or no shared texture ·
 *  `engine-args`: a bug on this side · `engine-exit`: the process died. */
export type EngineError = { code: string; detail: string };

export type EngineEvents = {
  loaded?: (info: EngineLoaded) => void;
  status?: (status: EngineStatus) => void;
  error?: (error: EngineError) => void;
  level?: (peak: EngineLevel) => void;
  audioOut?: (state: EngineAudioOut) => void;
  exit?: () => void;
};

type EngineEvent =
  | { ev: "hello"; proto: number }
  | { ev: "ready"; gpu: string; adapter?: "" | "match" | "none" }
  | ({ ev: "loaded" } & EngineLoaded)
  | { ev: "slots"; width: number; height: number; handles: (number | string | { stride: number; size: number })[] }
  | { ev: "frame"; slot: number }
  | ({ ev: "status" } & EngineStatus)
  | ({ ev: "error" } & EngineError)
  | { ev: "devices"; list: EngineDevice[] }
  | { ev: "level"; peak: EngineLevel }
  | ({ ev: "audio-out" } & EngineAudioOut);

/** `native/handles`: what Node can't do to take another process's textures, or to hand one over (the
 *  NDI output, `ndi/ndi-output.ts`). Windows has none. */
export type MacHandles = {
  lookup(id: number): string;
  release(pointer: string): void;
  machLookup(service: string): number;
  machSendSurface(port: number, ioSurface: Buffer): boolean;
  machRelease(port: number): void;
};
export type LinuxHandles = {
  listen(socketPath: string): number;
  accept(server: number, timeoutMs: number): number[];
  close(fd: number): void;
  connect(socketPath: string): number;
  sendFds(fd: number, text: string, fds: number[]): boolean;
};

let handlesAddon: MacHandles | LinuxHandles | null = null;
export function handles<T extends MacHandles | LinuxHandles>(): T {
  if (!handlesAddon) {
    const mod = { exports: {} as MacHandles | LinuxHandles };
    process.dlopen(mod, path.join(engineDir, "handles.node"));
    handlesAddon = mod.exports;
  }
  return handlesAddon as T;
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

/** The protocol this build's engine speaks, from the first one that started; null before any has said. */
let engineProto: number | null = null;
export function engineProtocol(): number | null {
  return engineProto;
}

/** An engine ended by itself before it was ready, or could not even be started (the AppImage on a Linux without
 *  libmpv: `hello`, then out at `mpv_create`). Until one says `ready`, asking the outputs launches nothing and the
 *  control window is told the engine cannot choose («none»): it waited on «pending» for good, the strip amber, and
 *  launched two engines every 2 s (2026-11-15 audit, A28). An engine main kills (a spare for another card,
 *  `killAllEngines`) is no sign. */
let failsToStart = false;
export function engineFailsToStart(): boolean {
  return failsToStart;
}

/** The session's verdict on the engine (owner, 2026-11-17): the first time one main did not kill ends before it was
 *  ready, or a GPU texture fails (`engine-gpu`), every file Chromium plays goes to Chromium until the app restarts, as
 *  with `--chromium-video`; what only the engine plays keeps trying it. Not `failsToStart`, which a later `ready`
 *  clears: a GPU or a libmpv that failed once is not trusted with the room's video again. */
let gaveUp = false;
const gaveUpListeners: (() => void)[] = [];
export function engineGaveUp(): boolean {
  return gaveUp;
}
export function onEngineGaveUp(listener: () => void): void {
  gaveUpListeners.push(listener);
}
function giveUp(why: string): void {
  if (gaveUp) return;
  gaveUp = true;
  console.warn(`[engine] ${why}: what Chromium plays goes to Chromium until the app restarts`);
  for (const listener of gaveUpListeners) listener();
}
function cannotStart(): void {
  failsToStart = true;
  giveUp("an engine could not start");
}

/** mpv's outputs, «auto» first, asked of the spare engine; null when this build's engine cannot say (none, or
 *  older than `AUDIO_DEVICE_PROTO`) or does not answer. */
export function listAudioDevices(): Promise<EngineDevice[] | null> {
  if (!engineAvailable() || failsToStart) return Promise.resolve(null);
  prewarmEngine();
  return spare ? spare.devices() : Promise.resolve(null);
}

/** Whether the NDI output takes the app's sound, read as each engine starts (the first spare starts before the NDI
 *  output does). On macOS such an engine opens the default output for 100 ms on start, which the NDI sound tap needs
 *  to hear it from its first file and nothing else does (`becomeKnownToCoreAudio`; 2026-11-15 audit, X21). A spare
 *  started before the sound was turned on is replaced (`matchSpareToNdiSound`): it missed the tap's first 300–400 ms of
 *  its first file. */
function ndiTakesSound(): boolean {
  try {
    const settings = getSettingsRepo();
    return settings.get("ndi.output.enabled") && settings.get("ndi.output.audio");
  } catch {
    return false;
  }
}

/** macOS: the NDI output's settings changed; a spare started for the other answer of `ndiTakesSound` is replaced. */
export function matchSpareToNdiSound(): void {
  if (process.platform !== "darwin" || !spare || spare.exited || spare.tapped === ndiTakesSound()) return;
  spare.kill();
  spare = null;
  prewarmEngine();
}

/** Starts the spare before the first file needs it. */
export function prewarmEngine(): void {
  if (!spare || spare.exited) spare = new MediaEngine();
}

/** The card Chromium draws with, as `--adapter` reads it (Windows, Linux); null on macOS or when none is active. */
let engineAdapter: string | null = null;
let loggedGpu = "";

async function chromiumAdapter(): Promise<string | null> {
  if (process.platform === "darwin") return null;
  type Device = {
    active?: boolean;
    vendorId?: number;
    deviceId?: number;
    subSysId?: number;
    revision?: number;
    deviceString?: string;
  };
  const info = (await app.getGPUInfo("complete")) as { gpuDevice?: Device[] };
  const d = info.gpuDevice?.find((device) => device.active === true);
  // On WARP (Chromium's software D3D11) the ids read 0xffff:0xffff and only the name says so; DXGI lists WARP as
  // 0x1414:0x8c (measured 2026-11-12, --use-angle=d3d11-warp).
  if (d?.vendorId === 0xffff && d.deviceString?.includes("Microsoft Basic Render Driver")) return "5140:140:0:0";
  // subSysId arrives signed: Electron cuts its int64 to an int.
  return d ? [d.vendorId ?? 0, d.deviceId ?? 0, (d.subSysId ?? 0) >>> 0, d.revision ?? 0].join(":") : null;
}

/**
 * Engines open the card Chromium draws with: the shared textures only open on the card that made them, and on a
 * laptop with two cards each process may get a different one (2026-11-12 GPU report; owner: automatic, no picker).
 * Read again when the GPU process dies, which can move Chromium to another card or to WARP; a spare started for
 * the old card is replaced. The first spare waits for the answer.
 */
export function startEngines(): void {
  fs.mkdirSync(engineCacheDir, { recursive: true });
  const follow = async (): Promise<void> => {
    const adapter = await chromiumAdapter().catch((error: unknown) => {
      console.warn("[engine] getGPUInfo failed", error);
      return null;
    });
    if (adapter !== engineAdapter) {
      engineAdapter = adapter;
      spare?.kill();
      spare = null;
    }
    prewarmEngine();
  };
  if (process.platform !== "darwin") {
    app.on("child-process-gone", (_event, details) => {
      if (details.type === "GPU") void follow();
    });
  }
  void follow();
}

/** Once per card, and a warning when the app's card was not found (the engine then used the default one). */
function logEngineGpu(gpu: string, adapter: string | undefined): void {
  const line = `${gpu} (${adapter || "default card"})`;
  if (line === loggedGpu) return;
  loggedGpu = line;
  if (adapter === "none") console.warn(`[engine] the app's card ${engineAdapter} was not found: the engine uses ${gpu}`);
  else console.info(`[engine] gpu: ${line}`);
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
  private loadedInfo: EngineLoaded | null = null;
  private lastStatus: EngineStatus | null = null;
  private failed = false;
  private ready = false;
  private killed = false;
  /** Every line to the engine, held until it says which protocol it speaks (`hello`, or 7 when `ready` came first). */
  private readonly gate = new EngineGate((line) => this.writeNow(line));
  private deviceReplies: ((list: EngineDevice[] | null) => void)[] = [];
  /** Every line, in order, behind main's read of the head of the file `load` was given. */
  private sent: Promise<void> = Promise.resolve();
  /** The file was text, not audio or video: no line but `quit` reaches the engine. */
  private refused = false;

  /** macOS: started knowing the NDI output takes the sound (`--ndi-tap`). */
  readonly tapped = process.platform === "darwin" && ndiTakesSound();

  constructor() {
    const args = ["--max-width", "1920", "--max-height", "1080", "--cache-dir", engineCacheDir];
    if (engineAdapter) args.push("--adapter", engineAdapter);
    if (this.tapped) args.push("--ndi-tap", "1");
    // QA only: each engine logs its rendered frames' times into this folder (native/engine/engine.cpp, `frameLog`).
    const frameLog = process.env["HIMNOVA_ENGINE_FRAME_LOG"];
    if (frameLog) args.push("--frame-log", path.join(frameLog, `engine-${process.pid}-${Date.now()}-${running.size}.log`));
    if (process.platform === "win32") {
      args.push("--parent", String(process.pid));
      if (orphanedWindowsHandles.length) args.push("--close-in-parent", orphanedWindowsHandles.join(","));
      orphanedWindowsHandles = [];
    } else if (process.platform === "linux") {
      this.socketPath = path.join(os.tmpdir(), `himnova-engine-${process.pid}-${Date.now()}-${running.size}.sock`);
      this.server = handles<LinuxHandles>().listen(this.socketPath);
      args.push("--fd-socket", this.socketPath);
    }
    this.child = spawn(enginePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    running.add(this);
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", jsonLineReader<EngineEvent>((event) => this.onEvent(event)));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", () => {
      // The engine is gone; `exit` says so.
    });
    this.child.once("error", (error) => {
      // Not started at all (not executable, say): `exit` may never come, so this stands for it. Kept as the spare, it
      // was handed to the next file as an engine that never started (2026-11-15 audit).
      if (!this.ready) cannotStart();
      for (const reply of this.deviceReplies.splice(0)) reply(null);
      this.exited = true;
      running.delete(this);
      if (spare === this) spare = null;
      this.fail({ code: "engine-exit", detail: error.message });
    });
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
    const line = `load ${Math.max(0, opts.startAtSeconds)} ${flag(opts.paused)} ${volume} ${flag(opts.loop)} ${flag(opts.audio)} ${longPathSafe(opts.file)}`;
    // The output opens where it is told before the file: the device goes first, to an engine that knows it.
    if (opts.device !== undefined) this.setDevice(opts.device);
    // Every file the engine plays comes through here (library, PREVIEW, a deck's clips and music, a song's video), and
    // a playlist with a video's extension made it project another file and fetch URLs (2026-11-15 audit, S1). A file
    // main cannot read goes on to the engine, which says so itself.
    this.sent = readHead(opts.file)
      .then((head) => {
        if (head && textInsteadOfMedia(head)) {
          this.refused = true;
          console.warn(`[engine] refused, text and not audio or video: ${opts.file}`);
          this.fail({ code: "engine-open", detail: "a text file (a playlist?), not audio or video" });
        } else this.gate.send(line);
      })
      .catch((error: unknown) => console.warn("[engine] load", error));
  }

  /** Where its sound goes from now on (mpv reopens its output there, a gap of a moment); «auto» the system's. The same
   *  device again reopens it if its sound was lost (`EngineEvents.audioOut`). */
  setDevice(device: string): void {
    if (/[\r\n]/.test(device)) throw new Error("a device name with a line break");
    this.gate.send(`device ${device}`, AUDIO_DEVICE_PROTO);
  }

  /** mpv's outputs as this engine sees them; null from an older engine, or with no answer in `timeoutMs`. */
  devices(timeoutMs = 3000): Promise<EngineDevice[] | null> {
    if (this.exited) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const reply = (list: EngineDevice[] | null) => {
        clearTimeout(timer);
        resolve(list);
      };
      // Waiting from now: an engine that dies before it says its protocol answers null at once, not at the timeout.
      this.deviceReplies.push(reply);
      this.gate.after((proto) => {
        if (proto < AUDIO_DEVICE_PROTO) return reply(null);
        this.writeNow("devices");
      });
    });
  }

  /** Still playing its file, with nothing gone wrong: one another session may take over (`retarget`). */
  get usable(): boolean {
    return this.loadedOnce && !this.exited && !this.failed;
  }

  /** Where it last said it stands, in seconds (0 before it says). */
  get position(): number {
    return this.lastStatus?.time ?? 0;
  }

  /** Hands this engine, file and all, to another session — PREVIEW's to the live one (owner, 2026-11-12): its
   *  frames go under `target` from now on, and `events` hear again what it already said. */
  retarget(target: string, events: EngineEvents): void {
    this.targetKey = target;
    this.events = events;
    if (this.loadedInfo) events.loaded?.(this.loadedInfo);
    if (this.lastStatus) events.status?.(this.lastStatus);
  }

  show(contents: WebContents): void {
    if (!this.targets.has(contents)) this.targets.set(contents, { busy: false });
  }

  /** Its frames go to these windows and no others: one that stopped copying the projector (the stage with its
   *  videos turned off) stops receiving them. */
  showOnly(contents: readonly WebContents[]): void {
    for (const target of this.targets.keys()) if (!contents.includes(target)) this.targets.delete(target);
    for (const target of contents) this.show(target);
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
    this.killed = true;
    if (!this.exited) this.child.kill("SIGKILL");
  }

  /** In order with everything else, once the engine has said its protocol and main has read the file's head. */
  private write(line: string): void {
    // A step that threw would leave the chain rejected, and every later line (a frame's `release`) dropped.
    this.sent = this.sent
      .then(() => {
        if (!this.refused || line === "quit") this.gate.send(line);
      })
      .catch((error: unknown) => console.warn("[engine] write", error));
  }

  private writeNow(line: string): void {
    if (!this.exited && this.child.stdin?.writable) this.child.stdin.write(line + "\n");
  }

  private onEvent(event: EngineEvent): void {
    engineProto = this.gate.heard(event);
    switch (event.ev) {
      case "hello":
        return;
      case "ready":
        this.ready = true;
        // The control window took «none» for the session: told, it asks for the outputs again (review of A28).
        if (failsToStart) broadcast("engine-starts", undefined);
        failsToStart = false;
        return logEngineGpu(event.gpu, event.adapter);
      case "loaded":
        this.loadedInfo = event;
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
      case "devices":
        for (const reply of this.deviceReplies.splice(0)) reply(event.list);
        return;
      case "level":
        return this.events.level?.(event.peak);
      case "audio-out":
        return this.events.audioOut?.({ ok: event.ok, device: event.device });
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
        const linux = handles<LinuxHandles>();
        this.linuxFds = linux.accept(this.server, 1000);
        // The ring is made once: nothing connects again, so the path goes now. Left for the exit, a main that was
        // killed (SIGKILL) left one socket in /tmp per engine it had ever started (2026-11-15 audit, X19).
        linux.close(this.server);
        this.server = -1;
        if (this.socketPath) fs.rmSync(this.socketPath, { force: true });
        this.socketPath = null;
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
    this.failed = true;
    if (error.code === "engine-gpu") giveUp(`the GPU failed the engine (${error.detail})`);
    this.events.error?.(error);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    if (!this.killed && !this.ready && code !== 0) cannotStart();
    running.delete(this);
    for (const reply of this.deviceReplies.splice(0)) reply(null);
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

/** The first `SNIFF_BYTES` of `file`, or null when main cannot read it. */
async function readHead(file: string): Promise<Uint8Array | null> {
  try {
    const handle = await fsp.open(file, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** libmpv opens files within Windows' MAX_PATH (260) even where long paths are on: a video deep in a
 *  church's OneDrive or SharePoint folder imported, probed and thumbnailed fine, then went live black and
 *  silent (2026-11-10 review, agent8-02). The `\\?\` form has no such limit, and libmpv opens it, UNC
 *  shares included (measured on Windows 11). Only for a long path: the short ones stay as they were. */
export function longPathSafe(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || file.length < 240 || file.startsWith("\\\\?\\")) return file;
  const full = path.win32.resolve(file);
  return full.startsWith("\\\\") ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}
