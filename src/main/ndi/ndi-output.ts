import { app, BrowserWindow, type OffscreenSharedTexture } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NDI_ERROR_CODES, NDI_SIZES, type NdiOutputStatus } from "@shared/types/ndi";
import type { SettingsMap } from "@shared/types/settings";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast } from "../services/broadcast";
import { projectionState } from "../services/projection-state";
import { getSettingsRepo } from "../services/repos";
import { enginePath } from "../paths";
import { engineAvailable, handles, type LinuxHandles, type MacHandles } from "../media/media-engine";
import { syncLiveEngine } from "../media/engine-sessions";

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

type Config = { name: string; width: number; height: number; fps: number };

let window: BrowserWindow | null = null;
let sender: NdiSender | null = null;
let running = "";
let status: NdiOutputStatus = { state: "off" };
let restartTimer: NodeJS.Timeout | null = null;
let serial = 0;

const RESTART_DELAY_MS = 2000;
/** With nobody watching, a frame at most this often. The NDI SDK hands the last frame it sent to every new
 *  receiver the moment it connects (measured 2026-11-09), and OBS can reconnect on every scene change:
 *  never sending would put a picture from minutes ago on air. The engine encodes these once each. */
const IDLE_FRAME_MS = 500;
/** A dropped paint whose page then went still is drawn again after this. */
const SETTLE_MS = 100;
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
  let settings: Pick<SettingsMap, "ndi.output.enabled" | "ndi.output.name" | "ndi.output.resolution" | "ndi.output.fps">;
  try {
    const repo = getSettingsRepo();
    settings = {
      "ndi.output.enabled": repo.get("ndi.output.enabled"),
      "ndi.output.name": repo.get("ndi.output.name"),
      "ndi.output.resolution": repo.get("ndi.output.resolution"),
      "ndi.output.fps": repo.get("ndi.output.fps"),
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
  };
  const key = JSON.stringify(config);
  if (key === running && window && !window.isDestroyed()) return;
  stopNdiOutput();
  running = key;
  if (!engineAvailable()) return setStatus({ state: "error", code: "ndi-engine-missing" });
  window = createNdiWindow(config);
  startSender(config);
}

/** Synchronous, for `before-quit` and the control window closing. */
export function stopNdiOutput(): void {
  running = "";
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  sender?.kill();
  sender = null;
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
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
  | { ev: "error"; code: string; detail: string };

const STDERR_TAIL_BYTES = 2048;

/** The media engine in its NDI mode, for one output configuration. */
class NdiSender {
  private readonly child: ChildProcess;
  private ready = false;
  private receivers = 0;
  private pending: OffscreenSharedTexture | null = null;
  private lastIdleFrame = 0;
  private settleTimer: NodeJS.Timeout | null = null;
  private machPort = 0;
  private socketFd = -1;
  private readonly machService: string = "";
  private readonly socketPath: string = "";
  private stdout = "";
  private stderrTail = "";
  private killed = false;

  constructor(
    config: Config,
    private readonly events: SenderEvents,
  ) {
    const args = ["--ndi-send", config.name, "--width", String(config.width), "--height", String(config.height), "--fps", String(config.fps)];
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
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", () => {
      // The engine is gone; `exit` says so.
    });
    this.child.once("error", (error) => console.warn("[ndi] engine", error.message));
    this.child.once("exit", (code, signal) => this.onExit(code, signal));
  }

  /** Takes the texture (true) until the engine has read it, or leaves it to the caller to release. */
  offer(texture: OffscreenSharedTexture): boolean {
    if (!this.ready) return false;
    const idleWait = this.receivers === 0 ? IDLE_FRAME_MS - (Date.now() - this.lastIdleFrame) : 0;
    if (this.pending || idleWait > 0) {
      // If the page goes still now, this was its last picture (the end of a fade): draw it again then.
      this.settleTimer ??= setTimeout(() => {
        this.settleTimer = null;
        this.events.redraw();
      }, Math.max(idleWait, SETTLE_MS));
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

  /** Synchronous: the texture in flight goes back now, before its window is destroyed. */
  kill(): void {
    this.killed = true;
    this.release();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  private release(): void {
    this.pending?.release();
    this.pending = null;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    const lines = this.stdout.split("\n");
    this.stdout = lines.pop() ?? "";
    for (const line of lines) {
      let event: SenderEvent;
      try {
        event = JSON.parse(line) as SenderEvent;
      } catch {
        continue;
      }
      this.onEvent(event);
    }
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
          return this.kill();
        }
        console.log(`[ndi] sending (${event.runtime})`);
        this.ready = true;
        return this.give({ state: "sending", receivers: 0 });
      case "done":
        return this.release();
      case "status":
        this.receivers = event.receivers;
        // A frame read before a status that says nobody is watching is still released by its `done`.
        return this.give({ state: "sending", receivers: event.receivers });
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
