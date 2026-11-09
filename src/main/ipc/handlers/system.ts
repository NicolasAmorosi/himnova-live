import { app, BrowserWindow, shell, type WebContents } from "electron";
import { userDataDir } from "../../paths";
import { getSettingsRepo } from "../../services/repos";
import { REPO_URL } from "../../updates/updater";
import type { Handlers } from "../register";
import type { Locale } from "@shared/types/settings";
import { IpcError } from "@shared/ipc/result";
import {
  INTERNALS_PAGES,
  type GpuStatus,
  type InternalsPage,
  type VideoDecoderReport,
} from "@shared/types/system";

/** PCI vendor ids, for the platforms whose basic GPU info carries no device
 *  name (macOS reports only ids). */
const GPU_VENDORS: Record<number, string> = {
  0x8086: "Intel",
  0x10de: "NVIDIA",
  0x1002: "AMD",
  0x106b: "Apple",
  0x5143: "Qualcomm",
};

type GpuDevice = { active?: boolean; vendorId?: number; deviceId?: number; deviceString?: string };

function deviceName(device: GpuDevice): string {
  const named = device.deviceString?.trim();
  if (named) return named;
  const vendor = device.vendorId !== undefined ? GPU_VENDORS[device.vendorId] : undefined;
  return vendor ?? `0x${(device.vendorId ?? 0).toString(16)}:0x${(device.deviceId ?? 0).toString(16)}`;
}

/** One window per page, reused: a second click brings it forward instead of
 *  stacking copies. */
const internalsWindows = new Map<InternalsPage, BrowserWindow>();

/**
 * The media probe: one CDP session on the calling window, alive from
 * `probeBegin` to `probeEnd`.
 *
 * CDP rather than anything in the page, because the only place Chromium says
 * which decoder it picked — and whether it was the GPU's — is its media
 * pipeline log: no web API exposes it. The `Media` domain streams exactly the
 * properties `chrome://media-internals` shows. Players are keyed by the url
 * their `kLoad` event names, which is how `probeEnd` finds the probe's own
 * element among whatever else the window is playing.
 */
type ProbePlayer = { url: string | null; properties: Map<string, string> };
type ProbeSession = {
  contents: WebContents;
  players: Map<string, ProbePlayer>;
  onMessage: (event: unknown, method: string, params: unknown) => void;
};
let probe: ProbeSession | null = null;

/** `Media.enable` never answers on a page that has not loaded — measured, it
 *  hangs on `about:blank` — so the wait is bounded. */
const MEDIA_ENABLE_TIMEOUT_MS = 2000;

function endProbe(): void {
  if (!probe) return;
  const { contents, onMessage } = probe;
  probe = null;
  contents.debugger.off("message", onMessage);
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  } catch {
    // Already gone with its window.
  }
}

function playerOf(players: Map<string, ProbePlayer>, playerId: string): ProbePlayer {
  let player = players.get(playerId);
  if (!player) {
    player = { url: null, properties: new Map() };
    players.set(playerId, player);
  }
  return player;
}

/** Folds one CDP `Media.*` message into the session. Everything arrives as
 *  strings; event values are JSON inside a string. */
function recordMediaMessage(players: Map<string, ProbePlayer>, method: string, params: unknown): void {
  const { playerId } = (params ?? {}) as { playerId?: string };
  if (!playerId) return;
  if (method === "Media.playerPropertiesChanged") {
    const { properties = [] } = params as { properties?: { name: string; value: string }[] };
    const player = playerOf(players, playerId);
    for (const { name, value } of properties) player.properties.set(name, value);
  } else if (method === "Media.playerEventsAdded") {
    const { events = [] } = params as { events?: { value: string }[] };
    for (const { value } of events) {
      try {
        const event = JSON.parse(value) as { event?: string; url?: string };
        if (event.event === "kLoad" && event.url) playerOf(players, playerId).url = event.url;
      } catch {
        // A malformed event is one fewer fact, not a failed probe.
      }
    }
  }
}

function reportFor(player: ProbePlayer): VideoDecoderReport {
  const props = player.properties;
  const hardware = props.get("kIsPlatformVideoDecoder");
  let codec: string | null = null;
  let profile: string | null = null;
  try {
    const [track] = JSON.parse(props.get("kVideoTracks") ?? "[]") as { codec?: string; profile?: string }[];
    codec = track?.codec ?? null;
    profile = track?.profile ?? null;
  } catch {
    // Unknown codec, still a useful decoder name.
  }
  const bitrate = Number(props.get("kBitrate"));
  return {
    decoderName: props.get("kVideoDecoderName") ?? null,
    hardware: hardware === undefined ? null : hardware === "true",
    codec,
    profile,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
  };
}

/** The website, and its guide's path per language (the landing's `src/i18n/routing.ts`: Spanish at the root). */
const SITE_URL = "https://lumina-live-site.vercel.app";
const GUIDE_PATH: Record<Locale, string> = { es: "/guia", en: "/en/guide", it: "/it/guida", pt: "/pt/guia" };

export const systemHandlers: Pick<
  Handlers,
  | "system:gpuStatus"
  | "system:openInternals"
  | "system:probeBegin"
  | "system:probeEnd"
  | "system:openLogsFolder"
  | "system:openSourceCode"
  | "system:openGuide"
> = {
  "system:openSourceCode": () => shell.openExternal(REPO_URL),
  "system:openGuide": () => shell.openExternal(`${SITE_URL}${GUIDE_PATH[getSettingsRepo().get("ui.locale")]}`),
  "system:openLogsFolder": async () => {
    // `openPath` resolves to an error MESSAGE rather than rejecting.
    const failure = await shell.openPath(userDataDir);
    if (failure) throw new IpcError({ code: "OPEN_FAILED", message: failure });
  },
  "system:gpuStatus": async (): Promise<GpuStatus> => {
    const info = (await app.getGPUInfo("basic")) as { gpuDevice?: GpuDevice[] };
    const features = app.getGPUFeatureStatus();
    return {
      devices: (info.gpuDevice ?? []).map((device) => ({
        name: deviceName(device),
        active: device.active === true,
      })),
      videoDecode: features.video_decode,
      gpuCompositing: features.gpu_compositing,
    };
  },

  "system:openInternals": ({ page }, ev) => {
    // The renderer is trusted, but a page name still becomes a URL here.
    if (!INTERNALS_PAGES.includes(page)) {
      throw new IpcError({ code: "INVALID_INPUT", message: "Unknown page." });
    }
    const existing = internalsWindows.get(page);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    // A child of the caller, so closing the control window takes it along —
    // otherwise it would keep the app alive on Windows/Linux, where the last
    // window closing is what quits.
    const parent = BrowserWindow.fromWebContents(ev.sender);
    const win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: 1100,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    internalsWindows.set(page, win);
    win.on("closed", () => internalsWindows.delete(page));
    void win.loadURL(`chrome://${page}`);
  },

  "system:probeBegin": async (_req, ev): Promise<boolean> => {
    endProbe();
    const contents = ev.sender;
    const players = new Map<string, ProbePlayer>();
    try {
      contents.debugger.attach("1.3");
    } catch {
      // Another CDP client got there first.
      return false;
    }
    const onMessage = (_event: unknown, method: string, params: unknown): void =>
      recordMediaMessage(players, method, params);
    contents.debugger.on("message", onMessage);
    probe = { contents, players, onMessage };
    try {
      await Promise.race([
        contents.debugger.sendCommand("Media.enable"),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), MEDIA_ENABLE_TIMEOUT_MS)),
      ]);
      return true;
    } catch {
      endProbe();
      return false;
    }
  },

  "system:probeEnd": ({ src }): VideoDecoderReport | null => {
    const players = probe?.players;
    endProbe();
    if (!players) return null;
    for (const player of players.values()) {
      if (player.url === src) return reportFor(player);
    }
    return null;
  },
};
