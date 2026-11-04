import type { Handlers } from "../register";
import { projectionState } from "../../services/projection-state";
import { createProjectionWindow } from "../../windows/projection-window";
import { getHistoryRepo, getSlidesRepo } from "../../services/repos";
import { broadcast } from "../../services/broadcast";
import { pinDecks } from "../../slides/deck-service";
import { commandLiveEngine, redrawEngineFrame, syncLiveEngine } from "../../media/engine-sessions";
import { IpcError } from "@shared/ipc/result";

let currentProgramId: number | null = null;

/** How long `projection:open` waits for the new window to mount: a renderer
 *  that never pulls its snapshot must not leave GO LIVE hanging. */
const PROJECTOR_MOUNT_TIMEOUT_MS = 5_000;
/** `webContents.id` → settles that window's `projection:open`. */
const mountWaiters = new Map<number, () => void>();

export function setCurrentProgramId(id: number | null): void {
  currentProgramId = id;
}

export function getCurrentProgramId(): number | null {
  return currentProgramId;
}

export const projectionHandlers: Pick<
  Handlers,
  | "projection:open"
  | "projection:close"
  | "projection:show"
  | "projection:mediaCommand"
  | "projection:setAudioTracks"
  | "projection:reportMediaStatus"
  | "projection:reportMediaError"
  | "projection:getSnapshot"
  | "projection:wantVideoFrame"
> = {
  "projection:open": ({ displayId }) => {
    const existing = projectionState.getWindow();
    if (existing) existing.close();
    const win = createProjectionWindow(displayId);
    projectionState.setWindow(win);
    // An engine video paused by the closed projector plays again, now into this window.
    syncLiveEngine();
    // Identity-checked (see `clearWindowIf`), and this is load-bearing:
    // `close()` above is asynchronous, so the OLD window's `closed` fires
    // AFTER this line has already registered the new one. Clearing
    // unconditionally left `projectionState.window` at `null` while the new
    // window sat on screen, very much alive — after which no
    // `projection:show` ever reached the projector again (it froze on
    // whatever was last on it) and `projection:close` closed nothing.
    win.on("closed", () => {
      // The broadcast is gated on `clearWindowIf` having actually fired, for
      // the identity reason spelled out above: during a reopen the OLD
      // window's `closed` arrives after the new one is registered, and
      // announcing that as "the projector is gone" would switch the control
      // window's live state off while a perfectly alive projector sits on
      // screen. A close the control window asked for (`projection:close`) has
      // already nulled the reference too, so it stays silent as well — the
      // control window does not need to be told what it just did.
      if (projectionState.clearWindowIf(win)) {
        broadcast("projection-closed", undefined);
        syncLiveEngine();
      }
    });
    // Answered once the page has mounted (its own `projection:getSnapshot`),
    // not once the window exists. The control commits GO LIVE when this
    // resolves, and a deck's auto-advance arms slide 1's timer at that commit:
    // answered earlier, slide 1 ran its clock while the page was still loading
    // — 0.2 s normally, up to 3 s with main busy — and a short one never showed.
    // A window that closes during that wait (closed from outside, a renderer
    // crash) answers `false`: its `projection-closed` reached the control
    // first, and answering as if it had mounted made `openIfNeeded` mark the
    // projector open again — after which no GO LIVE ever reopened it.
    const id = win.webContents.id;
    return new Promise<boolean>((resolve) => {
      const settle = (mounted: boolean) => {
        clearTimeout(timeout);
        mountWaiters.delete(id);
        resolve(mounted);
      };
      const timeout = setTimeout(() => settle(true), PROJECTOR_MOUNT_TIMEOUT_MS);
      mountWaiters.set(id, () => settle(true));
      win.once("closed", () => settle(false));
    });
  },

  "projection:close": () => {
    const win = projectionState.getWindow();
    win?.close();
    projectionState.setWindow(null);
    syncLiveEngine();
  },

  "projection:show": (output) => {
    projectionState.send(output);
    syncLiveEngine();
    getHistoryRepo().record(output, currentProgramId);

    // The deck currently on the projector must never be evicted mid-service —
    // this was silently possible before (see `deck-service.ts`'s `pinDecks`),
    // masked only by `evictIfOverCap`'s 24h grace window on recency.
    //
    // BLACK and LOGO deliberately do NOT clear the pin. They are overlays: the
    // deck is still the base content and comes back the moment the operator
    // lifts them, so unpinning there re-opened the exact hole this closes —
    // three minutes of BLACK over a deck, an eviction pass in between, and the
    // slides are gone when it comes back up. The pin is released by the next
    // output that genuinely replaces the content (a video, an image, a verse).
    if (output.kind === "slide") {
      const deck = getSlidesRepo().findDeckByAsset(output.deckAssetId);
      pinDecks("projected", deck ? [deck.id] : []);
    } else if (output.kind !== "black" && output.kind !== "logo") {
      pinDecks("projected", []);
    }
  },

  "projection:getSnapshot": (_req, ev) => {
    mountWaiters.get(ev.sender.id)?.();
    return projectionState.getSnapshot();
  },

  "projection:mediaCommand": (command) => {
    if (commandLiveEngine(command)) return;
    const win = projectionState.getWindow();
    win?.webContents.send("media-command", command);
  },

  "projection:setAudioTracks": (tracks) => {
    projectionState.setAudioTracks(tracks);
    syncLiveEngine();
  },

  "projection:wantVideoFrame": (req) => {
    if (typeof req?.key !== "string") throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid frame key." });
    redrawEngineFrame(req.key);
  },

  /** The projection window describing its own media element; forwarded to the
   *  control window, which owns the autoplay clock. */
  "projection:reportMediaStatus": (status) => {
    broadcast("media-status", status);
  },

  /** A file the projector could not load or decode. Logged here as well as
   *  forwarded: the control window's notice is transient by design (it
   *  disappears with the content it describes), so the log is the only record
   *  left for working out afterwards what went wrong during a service. */
  "projection:reportMediaError": (error) => {
    console.warn("[projection] media error", error.target.kind, error.url, error.code);
    broadcast("media-error", error);
  },
};
