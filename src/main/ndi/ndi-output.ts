import { app, BrowserWindow, type OffscreenSharedTexture } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NDI_ERROR_CODES, NDI_SIZES, type NdiAudioStatus, type NdiOutputStatus } from "@shared/types/ndi";
import type { MediaStatus } from "@shared/types/projection";
import type { SettingsMap } from "@shared/types/settings";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast } from "../services/broadcast";
import { projectionState } from "../services/projection-state";
import { getSettingsRepo } from "../services/repos";
import { enginePath } from "../paths";
import { engineAvailable, handles, type LinuxHandles, type MacHandles } from "../media/media-engine";
import { syncLiveEngine } from "../media/engine-sessions";
import { jsonLineReader } from "../media/engine-protocol";
import { paintVerdict } from "./ndi-pacing";

/**
 * The NDI® output (plan `2026-11-09-ndi`, phase 1): the projection drawn a second time in an offscreen
 * window of its own (`projection.html?role=ndi`, muted, never reporting), each painted frame handed as a
 * shared GPU texture to the media engine in its NDI mode (`native/engine/ndi.cpp`), which reads it and
 * sends the latest one at a steady rate. Main only passes a handle per frame — the copy and the encoder
 * live in the engine, so a slow church PC keeps its main thread, and an NDI crash takes down only this.
 *
 * Its own window rather than a capture of the projector's: it keeps working with the projector closed
 * or hidden, at its own fixed size. It draws what main last sent the projector (`projectionState`'s
 * mirrors), and the engine's videos reach it as they reach every window (`syncLiveEngine`).
 *
 * One frame in flight: main holds the texture until the engine answers `done`, and drops the paints of
 * that moment (Chromium's pool is small and a held texture stalls it). With no receivers, a frame at most
 * every `IDLE_FRAME_MS`, encoded once. `LUMINA_NDI_LIB` points at a runtime that is not installed (tests).
 */

type Config = { name: string; width: number; height: number; fps: number; audio: boolean; audioDelayMs: number };

let window: BrowserWindow | null = null;
let sender: NdiSender | null = null;
let running = "";
let status: NdiOutputStatus = { state: "off" };
let restartTimer: NodeJS.Timeout | null = null;
let serial = 0;
/** The sender being stopped, until it has gone: the next one waits for it (`syncNdiOutput`). */
let leaving: Promise<void> = Promise.resolve();
/** How long a sender asked to quit has before it is killed. */
const QUIT_GRACE_MS = 1000;

const RESTART_DELAY_MS = 2000;
const PRELOAD = path.join(__dirname, "../preload/index.js");

function setStatus(next: NdiOutputStatus): void {
  status = next;
  broadcast("ndi-status", next);
}

export function ndiOutputStatus(): NdiOutputStatus {
  return status;
}

/** Starts, stops or rebuilds the output from its settings: at launch (after the control window has
 *  loaded — Playwright takes the first window that loads as the control one) and when one changes. */
export function syncNdiOutput(): void {
  let settings: Pick<
    SettingsMap,
    "ndi.output.enabled" | "ndi.output.name" | "ndi.output.resolution" | "ndi.output.fps" | "ndi.output.audio" | "ndi.output.audioDelayMs"
  >;
  try {
    const repo = getSettingsRepo();
    settings = {
      "ndi.output.enabled": repo.get("ndi.output.enabled"),
      "ndi.output.name": repo.get("ndi.output.name"),
      "ndi.output.resolution": repo.get("ndi.output.resolution"),
      "ndi.output.fps": repo.get("ndi.output.fps"),
      "ndi.output.audio": repo.get("ndi.output.audio"),
      "ndi.output.audioDelayMs": repo.get("ndi.output.audioDelayMs"),
    };
  } catch {
    return;
  }
  if (!settings["ndi.output.enabled"]) {
    stopNdiOutput();
    setStatus({ state: "off" });
    return;
  }
  const config: Config = {
    name: settings["ndi.output.name"].trim(),
    ...NDI_SIZES[settings["ndi.output.resolution"]],
    fps: settings["ndi.output.fps"],
    audio: settings["ndi.output.audio"],
    audioDelayMs: settings["ndi.output.audioDelayMs"],
  };
  const key = JSON.stringify(config);
  if (key === running && window && !window.isDestroyed()) return;
  stopNdiOutput();
  running = key;
  if (!engineAvailable()) return setStatus({ state: "error", code: "ndi-engine-missing" });
  window = createNdiWindow(config);
  // After the one before has said goodbye: the same name registered while it was still on the network could come
  // back under another one.
  setStatus({ state: "starting" });
  void leaving.then(() => {
    if (running === key && !sender && window && !window.isDestroyed()) startSender(config);
  });
}

/** Synchronous, for `before-quit` and the control window closing. */
export function stopNdiOutput(): void {
  running = "";
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (sender) leaving = sender.kill();
  sender = null;
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}

/** The projector's report of its own Chromium video: the NDI window's copy of that video follows it
 *  (`follow-projector.ts`), so the picture NDI sends keeps step with the sound the room — and NDI — hears. */
export function forwardMediaStatusToNdi(status: MediaStatus): void {
  if (status.target.kind === "audio" || !window || window.isDestroyed()) return;
  window.webContents.send("media-status", status);
}

/** For `userFacingWindows()`: a hidden helper, like the rasterizer. */
export function isNdiWindow(win: BrowserWindow): boolean {
  return win === window;
}

/** A new textured paint now, even of a still page. `invalidate()` makes a paint that carries no texture
 *  (measured 2026-11-09); restarting the painting draws a whole frame. Never left stopped: the page's clock
 *  stops with it, and a receiver arriving mid-fade got the old picture. */
function drawFreshFrame(): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.stopPainting();
  window.webContents.startPainting();
}

function startSender(config: Config): void {
  setStatus({ state: "starting" });
  let hadReceivers = false;
  const mine = new NdiSender(config, {
    status: (next) => {
      if (sender !== mine) return;
      setStatus(next);
      // A still slide paints nothing more: a first receiver is drawn a frame at once.
      const watched = next.state === "sending" && next.receivers > 0;
      if (watched && !hadReceivers) drawFreshFrame();
      hadReceivers = watched;
    },
    redraw: () => {
      if (sender === mine) drawFreshFrame();
    },
    exit: (restart) => {
      if (sender !== mine) return;
      sender = null;
      if (!restart) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (running && window && !window.isDestroyed()) startSender(config);
      }, RESTART_DELAY_MS);
    },
  });
  sender = mine;
}

function createNdiWindow(config: Config): BrowserWindow {
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    show: false,
    // Windows clamps even an offscreen window to the screen (1920×1032 under a taskbar), and a frame eats
    // into it: frameless, content-sized and resized once created is what gives the whole picture.
    frame: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: { useSharedTexture: true },
    },
  });
  win.setContentSize(config.width, config.height);
  trustWindow(win);
  // Video only: the projector is what the room hears.
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(config.fps);
  // Painting goes on with nobody watching (each texture is released at once: as cheap as no NDI, measured
  // in phase 0).
  win.webContents.on("paint", (event) => {
    const texture = event.texture;
    if (texture && !sender?.offer(texture)) texture.release();
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.warn("[ndi] output page gone", details.reason);
    if (!win.isDestroyed()) win.webContents.reload();
  });
  projectionState.addMirror(win);
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl) void win.loadURL(`${devServerUrl}/projection.html?role=ndi`);
  else void win.loadFile(path.join(__dirname, "../renderer/projection.html"), { query: { role: "ndi" } });
  win.once("closed", () => {
    if (window === win) window = null;
    syncLiveEngine();
  });
  syncLiveEngine();
  return win;
}

type SenderEvents = {
  status: (status: NdiOutputStatus) => void;
  /** A paint was dropped and none came after it: the page's last picture never reached the engine. */
  redraw: () => void;
  exit: (restart: boolean) => void;
};

type SenderEvent =
  | { ev: "ready"; runtime: string }
  | { ev: "done" }
  | { ev: "status"; receivers: number }
  | { ev: "audio"; state: "on" | "off"; detail?: string; level?: number }
  | { ev: "error"; code: string; detail: string };

const STDERR_TAIL_BYTES = 2048;

/** The media engine in its NDI mode, for one output configuration. */
class NdiSender {
  private readonly child: ChildProcess;
  private ready = false;
  private receivers = 0;
  private audio: NdiAudioStatus | null = null;
  private pending: OffscreenSharedTexture | null = null;
  private lastIdleFrame = 0;
  private settleTimer: NodeJS.Timeout | null = null;
  private machPort = 0;
  private socketFd = -1;
  private readonly machService: string = "";
  private readonly socketPath: string = "";
  private stderrTail = "";
  private killed = false;
  private readonly gone: Promise<void>;

  constructor(
    config: Config,
    private readonly events: SenderEvents,
  ) {
    const args = ["--ndi-send", config.name, "--width", String(config.width), "--height", String(config.height), "--fps", String(config.fps)];
    if (config.audio) args.push("--audio", "1", "--audio-delay", String(config.audioDelayMs));
    const lib = process.env["LUMINA_NDI_LIB"];
    if (lib) args.push("--ndi-lib", lib);
    serial++;
    if (process.platform === "win32") args.push("--parent", String(process.pid));
    else if (process.platform === "darwin") {
      this.machService = `com.worshipapp.ndi.${process.pid}.${serial}`;
      args.push("--mach-service", this.machService);
    } else {
      this.socketPath = path.join(os.tmpdir(), `lumina-ndi-${process.pid}-${serial}.sock`);
      args.push("--fd-socket", this.socketPath);
    }
    this.child = spawn(enginePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", jsonLineReader<SenderEvent>((event) => this.onEvent(event)));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", () => {
      // The engine is gone; `exit` says so.
    });
    this.child.once("error", (error) => console.warn("[ndi] engine", error.message));
    this.child.once("exit", (code, signal) => this.onExit(code, signal));
    this.gone = new Promise((resolve) => this.child.once("exit", () => resolve()));
  }

  /** Takes the texture (true) until the engine has read it, or leaves it to the caller to release. */
  offer(texture: OffscreenSharedTexture): boolean {
    const verdict = paintVerdict({
      ready: this.ready,
      inFlight: this.pending !== null,
      receivers: this.receivers,
      msSinceIdleFrame: Date.now() - this.lastIdleFrame,
    });
    if (!verdict.send) {
      // If the page goes still now, this was its last picture (the end of a fade): draw it again then.
      if (verdict.redrawInMs !== null)
        this.settleTimer ??= setTimeout(() => {
          this.settleTimer = null;
          this.events.redraw();
        }, verdict.redrawInMs);
      return false;
    }
    const { handle, codedSize } = texture.textureInfo;
    let sent = false;
    try {
      if (handle.ntHandle && this.child.stdin?.writable) {
        // Queued even when the pipe is full; the engine answers `done` for it either way.
        this.child.stdin.write(`frame ${handle.ntHandle.readBigUInt64LE(0)}\n`);
        sent = true;
      } else if (handle.ioSurface && this.machPort) {
        sent = handles<MacHandles>().machSendSurface(this.machPort, handle.ioSurface);
      } else if (handle.nativePixmap && this.socketFd >= 0) {
        const { planes, modifier } = handle.nativePixmap;
        const text = [codedSize.width, codedSize.height, modifier, planes.length, ...planes.flatMap((p) => [p.stride, p.offset])].join(" ");
        sent = handles<LinuxHandles>().sendFds(this.socketFd, text, planes.map((p) => p.fd));
      }
    } catch (error) {
      console.warn("[ndi] frame not sent", error instanceof Error ? error.message : error);
    }
    if (!sent) return false;
    this.pending = texture;
    if (this.receivers === 0) this.lastIdleFrame = Date.now();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    return true;
  }

  /**
   * The texture in flight goes back now, before its window is destroyed; the engine is asked to quit, so the NDI
   * library says goodbye on the network — killed, it left its source listed on other computers for hours (Windows,
   * 2026-11-10: a receiver connected to that ghost and got nothing). Killed only if still there a second later.
   * Resolves once it has gone.
   */
  kill(): Promise<void> {
    this.killed = true;
    this.release();
    const child = this.child;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end("quit\n");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, QUIT_GRACE_MS).unref();
    }
    return this.gone;
  }

  private release(): void {
    this.pending?.release();
    this.pending = null;
  }

  private onEvent(event: SenderEvent): void {
    switch (event.ev) {
      case "ready":
        try {
          if (this.machService) this.machPort = handles<MacHandles>().machLookup(this.machService);
          if (this.socketPath) this.socketFd = handles<LinuxHandles>().connect(this.socketPath);
        } catch (error) {
          console.warn("[ndi] engine unreachable", error instanceof Error ? error.message : error);
          this.give({ state: "error", code: "ndi-gpu" });
          void this.kill();
          return;
        }
        console.log(`[ndi] sending (${event.runtime})`);
        this.ready = true;
        return this.give({ state: "sending", receivers: 0, audio: this.audio });
      case "done":
        return this.release();
      case "status":
        this.receivers = event.receivers;
        // A frame read before a status that says nobody is watching is still released by its `done`.
        return this.give({ state: "sending", receivers: event.receivers, audio: this.audio });
      case "audio":
        if (event.state === "off") console.warn("[ndi] no sound:", event.detail);
        this.audio =
          event.state === "on" ? { state: "on", levelDb: event.level ?? null } : { state: "unavailable", detail: event.detail ?? "" };
        return this.ready ? this.give({ state: "sending", receivers: this.receivers, audio: this.audio }) : undefined;
      case "error":
        console.warn("[ndi] engine", event.code, event.detail);
        if (event.code === "ndi-runtime-missing") return this.give({ state: "runtime-missing" });
        return this.give({ state: "error", code: NDI_ERROR_CODES.find((known) => known === event.code) ?? "ndi-send" });
    }
  }

  private give(next: NdiOutputStatus): void {
    this.events.status(next);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.release();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.machPort) handles<MacHandles>().machRelease(this.machPort);
    if (this.socketFd >= 0) handles<LinuxHandles>().close(this.socketFd);
    if (this.socketPath) fs.rm(this.socketPath, { force: true }, () => {});
    if (this.killed) return this.events.exit(false);
    // 2 bad arguments, 3 no runtime, 4 NDI refused (its error event already said which): starting again
    // changes nothing until the user acts. Anything else is a crash, and the output comes back by itself.
    const final = code !== null && code >= 2 && code <= 4;
    if (!final) {
      console.warn(`[ndi] engine exited ${signal ?? code}: ${this.stderrTail.trim().slice(-300)}`);
      this.give({ state: "error", code: "ndi-exit" });
    }
    this.events.exit(!final);
  }
}
