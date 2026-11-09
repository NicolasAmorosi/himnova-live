import type { BrowserWindow } from "electron";
import type { AudioTrackPush, ProjectionOutput } from "@shared/types/projection";

/**
 * Holds the last output sent to the projection window and a reference to that
 * window. `getSnapshot()` is what the projection window pulls once on mount:
 * a fresh `projection:open` shows the window before its page has loaded, and
 * `send()`/`setAudioTracks()` calls made in that gap (goLive() runs right
 * after `openIfNeeded()`, with no wait for the page to be ready) would
 * otherwise race the renderer's own `display-content`/`audio-tracks`
 * listener — pushed while nothing is listening yet is a silent drop, not a
 * queued delivery. Pulling the last known state once mounted needs no timing
 * assumption about `did-finish-load` vs. React mounting.
 */
class ProjectionState {
  private window: BrowserWindow | null = null;
  /** Windows that draw the same picture without being the projector: the NDI output's offscreen window.
   *  They get every output, never the audio tracks (they play no sound), and they report nothing. */
  private readonly mirrors = new Set<BrowserWindow>();
  private lastOutput: ProjectionOutput | null = null;
  private lastAudioTracks: AudioTrackPush[] = [];

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  /**
   * Drops the reference only if `win` is still the current window, and reports
   * whether it did — the caller broadcasts "the projector is gone" on the
   * strength of that answer, so a `false` here is what stops a reopen from
   * announcing the OLD window's death over the NEW window that is on screen.
   *
   * A `closed` listener must never clear this unconditionally: `close()` is
   * asynchronous, so a reopen (`projection:open` → close the old one, create a
   * new one) delivers the OLD window's `closed` after the new one is already
   * registered, and an unconditional clear would leave main convinced there is
   * no projector while one is on screen. Comparing against the raw field
   * rather than `getWindow()` matters too: by the time `closed` fires for the
   * current window it is already destroyed, so `getWindow()` answers `null`
   * and would never match.
   */
  clearWindowIf(win: BrowserWindow): boolean {
    if (this.window !== win) return false;
    this.window = null;
    return true;
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  addMirror(win: BrowserWindow): void {
    this.mirrors.add(win);
    win.once("closed", () => this.mirrors.delete(win));
  }

  getMirrors(): BrowserWindow[] {
    return [...this.mirrors].filter((win) => !win.isDestroyed());
  }

  send(output: ProjectionOutput): void {
    this.lastOutput = output;
    for (const win of [this.getWindow(), ...this.getMirrors()]) win?.webContents.send("display-content", output);
  }

  setAudioTracks(tracks: AudioTrackPush[]): void {
    this.lastAudioTracks = tracks;
    this.getWindow()?.webContents.send("audio-tracks", tracks);
  }

  getSnapshot(): { output: ProjectionOutput | null; audioTracks: AudioTrackPush[] } {
    return { output: this.lastOutput, audioTracks: this.lastAudioTracks };
  }
}

export const projectionState = new ProjectionState();
