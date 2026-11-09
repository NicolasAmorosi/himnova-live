import { useEffect } from "react";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { advanceSlide, advanceSong, goLive, jumpSong, toggleOverlay, toggleSongLyrics } from "@renderer/lib/actions/playback";
import type { SongJumpTarget } from "@shared/song-jump";
import { advancePreview } from "@renderer/lib/actions/preview";
import { toggleAutoplay } from "@renderer/effects/deck-autoplay";
import { advanceVerse } from "@renderer/lib/actions/bible";
import { removeSelected } from "@renderer/lib/actions/remove-selected";
import { onIpc } from "@renderer/lib/ipc";
import { isPointerFocused, trackFocusModality } from "@renderer/lib/focus-modality";

const ARROW_KEYS_LIST: string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/**
 * What a presentation remote sends for «next» and «back»: PageDown and PageUp
 * (Logitech's own table for the R400/R700/R800, and what the clones copy). Never
 * suppressed, not even inside a text field — a single-line field has nothing to
 * page through, and the remote is often in the preacher's hand while the
 * operator is typing the next verse. Its blank-screen button sends «.», which
 * is BLACK below.
 */
const REMOTE_KEYS = new Set(["PageUp", "PageDown"]);

/** Live stepping: the keyboard's arrows and the remote's buttons. */
const LIVE_STEP: Record<string, 1 | -1> = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 };

// A text field consumes every keystroke — anything else would type into it.
const TEXT_ENTRY_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
// ...except the `<input>` types that are not text entry at all. A range is a
// slider: it owns the arrows (and Home/End) and nothing else. Treating it as a
// text field would have made `b` and `l` — BLACK and LOGO, the controls an
// operator reaches for when something appears the congregation should not
// see — dead for as long as a volume slider kept focus, which is right after
// they touched one. Same defect the comment on `suppressesKey` describes for
// buttons, by a different route.
const SLIDER_INPUT_KEYS = new Set([...ARROW_KEYS_LIST, "Home", "End"]);
// A button or a link consumes only the keys that actually do something to it:
// Enter and Space activate it, and the arrows drive the roving tabindex of the
// resource grid.
const ACTIVATION_TAGS = new Set(["BUTTON", "A"]);
const ARROW_KEYS = new Set(ARROW_KEYS_LIST);
const KEYS_A_CONTROL_CONSUMES = new Set(["Enter", " ", ...ARROW_KEYS]);
// Widgets whose arrows belong to them, declared by role instead of implied by
// a tag. `MediaScrubber` is what forced this: a `<div role="slider">` with its
// own arrow handling, so on a focused scrubber ArrowRight seeked five seconds
// AND advanced the live slide — in the same keypress, with the operator only
// asking for one of them. A `<div>` is not in `ACTIVATION_TAGS`, so nothing
// caught it; the role is exactly the declaration that says it should be.
const ARROW_CONSUMING_ROLES = new Set([
  "slider",
  "spinbutton",
  "listbox",
  "option",
  "combobox",
  "menu",
  "menubar",
  "menuitem",
  "tab",
  "tablist",
  "tree",
  "treeitem",
  "grid",
]);

function isTextEntry(target: HTMLElement): boolean {
  if (target instanceof HTMLInputElement && target.type === "range") return false;
  return target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName);
}

/**
 * Per KEY, not per element.
 *
 * Suppressing every shortcut whenever a `<button>` had focus looked harmless
 * and was not: Chromium focuses a button when you click it, so after a single
 * click on ANY button in the app — GO LIVE, LOGO, save, any `IconButton` — the
 * `b` and `l` shortcuts stopped working, with nothing on screen to say why.
 * BLACK is the control an operator reaches for when something appears that the
 * congregation should not see, and it was dead for the rest of the service
 * unless they happened to click on empty space. `b`, `l`, Delete and Backspace
 * mean nothing to a button, so there was never anything to protect.
 *
 * And a control the MOUSE focused keeps no key at all, whatever its role: a
 * tab, a volume slider or a seek bar clicked a moment ago used to keep the
 * arrows, so → changed the resource tab, the volume or the position instead of
 * the slide on the projector (owner, 2026-11-03: on the work screen the keys
 * always work). Reached with Tab, each control keeps its own keys. The widgets
 * that handle the arrows themselves let go of them the same way
 * (`isPointerFocused` in `Tabs`, `MediaScrubber`, `Select`, `Menu`, `VirtualGrid`).
 */
function suppressesKey(target: EventTarget | null, key: string): boolean {
  if (REMOTE_KEYS.has(key) || !(target instanceof HTMLElement)) return false;
  if (isTextEntry(target)) return true;
  if (isPointerFocused(target)) return false;
  if (target instanceof HTMLInputElement && target.type === "range") return SLIDER_INPUT_KEYS.has(key);
  if (ACTIVATION_TAGS.has(target.tagName) && KEYS_A_CONTROL_CONSUMES.has(key)) return true;
  const role = target.getAttribute("role");
  return role !== null && ARROW_CONSUMING_ROLES.has(role) && ARROW_KEYS.has(key);
}

function black(): void {
  void toggleOverlay("black");
}

function logo(): void {
  void toggleOverlay("logo");
}

/** Keys that act once per press. Held down, they act once: a held B flickered
 *  the projector between BLACK and the slide, and a held Enter sent the preview
 *  live again on every repeat — a new scene each time, the video back to 0. A
 *  remote that repeats on a long press did the same. Only stepping repeats. */
const ACTIONS: Record<string, () => void> = {
  Delete: removeSelected,
  Backspace: removeSelected,
  // Pause/resume a self-advancing deck: the operator has to be able to freeze
  // a PPT that plays by itself.
  " ": () => {
    const { base, liveDeck } = useProjectionStore.getState();
    if (base?.kind === "deck" && liveDeck?.autoAdvance) toggleAutoplay();
  },
  b: black,
  B: black,
  // A presentation remote's blank-screen button.
  ".": black,
  l: logo,
  L: logo,
  Enter: () => void goLive(),
};

/** The sections a letter jumps to while a song is live (owner, 2026-11-04):
 *  C chorus, P bridge (puente), F ending (final). B is BLACK, so no B. */
const SONG_SECTION_LETTERS: Record<string, SongJumpTarget["type"]> = { c: "chorus", p: "bridge", f: "ending" };

/** What a key does to a live song: a jump (1–9 = verse N, by the physical
 *  key, so Shift+2 is still a 2), T to hide or show the lyrics, or nothing. */
function songKey(key: string, code: string): SongJumpTarget | "lyrics" | null {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(key) ? key : undefined);
  if (digit) return { type: "verse", number: Number(digit) };
  const letter = key.toLowerCase();
  if (letter === "t") return "lyrics";
  const type = SONG_SECTION_LETTERS[letter];
  return type ? { type, number: null } : null;
}

/** Runs the shortcut `key` stands for, if any, and says whether it was one.
 *  Shared by the control window's own keys and the ones the projector forwards
 *  (`projector-key`), so a key means the same thing in either window. */
function runShortcut(key: string, repeat: boolean, shift = false, code = ""): boolean {
  const step = LIVE_STEP[key];
  if (step !== undefined) {
    const { base } = useProjectionStore.getState();
    if (base?.kind === "deck") advanceSlide(step, repeat);
    else if (base?.kind === "bible") advanceVerse(step);
    else if (base?.kind === "song") advanceSong(step);
    else return false;
    return true;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    advancePreview(key === "ArrowDown" ? 1 : -1);
    return true;
  }
  // Only with a song live: anywhere else these keys are nobody's.
  const song = useProjectionStore.getState().base?.kind === "song" ? songKey(key, code) : null;
  if (song) {
    if (!repeat) {
      if (song === "lyrics") toggleSongLyrics();
      else jumpSong(song, shift ? -1 : 1);
    }
    return true;
  }
  const action = ACTIONS[key];
  if (!action) return false;
  if (!repeat) action();
  // Prevented even when it does nothing here: reaching this from a clicked
  // button, Space would otherwise press that button again (see
  // `lib/focus-modality.ts`).
  return true;
}

/**
 * App-wide keyboard shortcuts, mounted once from App.tsx. The split follows
 * the two-stage flow, which is what makes them safe to press blind:
 *
 * - ←/→ and a remote's PageUp/PageDown: navigate what is LIVE — the deck on the
 *   projector, the verse or the song on it. Derived from `base`, not from which panel
 *   has focus, so they always mean the same thing.
 * - ↑/↓: navigate the PREVIEW cursor. Nothing reaches the projector.
 * - Enter: send the preview to the projector (the GO LIVE button), also right
 *   after clicking a button with the mouse — see `lib/focus-modality.ts`.
 * - Space: pause/resume a self-advancing deck.
 * - With a song live: 1–9 verse N, C chorus, P bridge, F ending — the next
 *   time it is sung, Shift the previous one — and T hides or shows the lyrics.
 * - B (or a remote's «.»)/L: toggle BLACK/LOGO overlay.
 * - Delete/Backspace: remove the selected library or schedule item.
 * - Escape in a text field gives the keys back: it leaves the field.
 *
 * Also answered while the PROJECTION window has the keyboard — macOS focuses it
 * when it opens, and a click on the projector's screen does it on any system —
 * through main's `projector-key` forward.
 *
 * Suppressed entirely while `suspended` (any modal open — see
 * `useAnyModalOpen`): only the work screen has shortcuts. In a text field only
 * the remote's keys work; on a control reached with Tab, that control keeps
 * the keys it consumes (see `suppressesKey`); on one the mouse focused, none.
 */
export function useGlobalShortcuts(suspended: boolean): void {
  useEffect(trackFocusModality, []);

  useEffect(() => {
    if (suspended) return;

    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A key a widget already handled is not a shortcut. `Select` answers
      // Enter on its own trigger, which is a button the mouse may have focused,
      // and choosing a Bible version must not also send the preview live.
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && e.target instanceof HTMLElement && isTextEntry(e.target)) {
        e.target.blur();
        return;
      }
      if (suppressesKey(e.target, e.key)) return;
      if (runShortcut(e.key, e.repeat, e.shiftKey, e.code)) e.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    const stopProjectorKeys = onIpc("projector-key", ({ code, key, repeat, shift }) => {
      runShortcut(key, repeat, shift, code);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      stopProjectorKeys();
    };
  }, [suspended]);
}
