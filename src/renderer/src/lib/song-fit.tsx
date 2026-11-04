import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { SongScene } from "@renderer/components/shared/song-scene";
import { useDisplayStore } from "@renderer/stores/display.store";
import type { DisplayInfo } from "@shared/types/display";
import type { ResolvedSong, SongTheme } from "@shared/types/song";

/** The monitors are 16:9 (`Monitor`). */
const MONITOR_ASPECT = 16 / 9;

/** The width the slides are laid out at. Everything is in `cqw`, so the answer
 *  does not depend on it beyond rounding. */
const STAGE_WIDTH_PX = 1000;

/** `measureFittedSize`'s numbers, for its reasons (`bible-scene.tsx`). */
const FIT_STEPS = 8;
const FIT_TOLERANCE_PX = 1;

const MAX_CACHED = 500;

/**
 * The proportion a song is measured at: the projector's, unless the 16:9
 * monitors are SHORTER than it — then theirs, so a slide that fits the
 * projector never overflows the monitor the operator reads it on.
 */
export function measureAspect(displays: readonly DisplayInfo[], displayId: number | null): number {
  const bounds = displays.find((display) => display.id === displayId)?.bounds;
  const projector = bounds && bounds.height > 0 ? bounds.width / bounds.height : MONITOR_ASPECT;
  return Math.max(projector, MONITOR_ASPECT);
}

export function currentMeasureAspect(): number {
  const { displayId, displays } = useDisplayStore.getState();
  return measureAspect(displays, displayId);
}

function fitKey(song: ResolvedSong, theme: SongTheme, aspect: number): string {
  return JSON.stringify([song.slides.map((slide) => slide.lines), theme, aspect.toFixed(4)]);
}

/** The song's size, and the slides (their lines joined by `\n`) that do not
 *  fit even at the floor — the ones the editor asks to split. */
export type SongFit = { sizeCqw: number; overflowing: readonly string[] };

const sizes = new Map<string, SongFit>();
const inFlight = new Map<string, Promise<SongFit>>();

function remember(key: string, size: SongFit): void {
  sizes.set(key, size);
  if (sizes.size > MAX_CACHED) sizes.delete(sizes.keys().next().value!);
}

function fits(stage: HTMLElement, block: HTMLElement): boolean {
  const { paddingBottom, paddingTop } = getComputedStyle(stage);
  const available = stage.clientHeight - parseFloat(paddingTop) - parseFloat(paddingBottom);
  return (
    block.scrollHeight <= available + FIT_TOLERANCE_PX && block.scrollWidth <= block.clientWidth + FIT_TOLERANCE_PX
  );
}

/** The largest size in `[min, max]` at which every pair fits, or `min`. One
 *  layout per probe: every size is written, then every block is read. */
function search(pairs: readonly { block: HTMLElement; stage: HTMLElement }[], max: number, min: number): number {
  const fitsAll = (cqw: number) => {
    for (const { block } of pairs) block.style.fontSize = `${cqw}cqw`;
    return pairs.every(({ block, stage }) => fits(stage, block));
  };
  if (fitsAll(max)) return max;
  if (!fitsAll(min)) return min;
  let low = min;
  let high = max;
  for (let step = 0; step < FIT_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (fitsAll(mid)) low = mid;
    else high = mid;
  }
  return Math.floor(low * 100) / 100;
}

async function measure(song: ResolvedSong, theme: SongTheme, aspect: number): Promise<SongFit> {
  const max = theme.text.sizeCqw;
  const min = Math.min(theme.minSizeCqw, max);
  // A chorus sung four times is measured once.
  const slides = [...new Map(song.slides.map((slide) => [slide.lines.join("\n"), slide.lines])).values()];
  if (slides.length === 0) return { sizeCqw: max, overflowing: [] };

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, { position: "fixed", left: "-100000px", top: "0", visibility: "hidden" });
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    // The same component every screen draws, so what fits here fits there.
    flushSync(() =>
      root.render(
        slides.map((lines, index) => (
          <div
            // The list never reorders: it is drawn once and thrown away.
            key={index}
            style={{
              containerType: "inline-size",
              height: `${STAGE_WIDTH_PX / aspect}px`,
              overflow: "hidden",
              position: "relative",
              width: `${STAGE_WIDTH_PX}px`,
            }}
          >
            <SongScene content={{ backgroundUrl: null, lines, sizeCqw: max, theme }} />
          </div>
        )),
      ),
    );
    // Laying it out is what asks for the faces it uses; measuring before
    // they arrive would measure the fallback font.
    void host.offsetHeight;
    await document.fonts.ready;
    const pairs = [...host.querySelectorAll<HTMLElement>("[data-song-stage]")].flatMap((stage) => {
      const block = stage.querySelector<HTMLElement>("[data-song-block]");
      return block ? [{ block, stage }] : [];
    });
    const sizeCqw = search(pairs, max, min);
    // At the floor, some slide may still not fit: name it.
    if (sizeCqw <= min) for (const { block } of pairs) block.style.fontSize = `${min}cqw`;
    const overflowing =
      sizeCqw > min
        ? []
        : slides.filter((_, index) => {
            const pair = pairs[index];
            return pair !== undefined && !fits(pair.stage, pair.block);
          });
    return { sizeCqw, overflowing: overflowing.map((lines) => lines.join("\n")) };
  } finally {
    root.unmount();
    host.remove();
  }
}

/** The song's one size for `theme` at `aspect`, in `cqw`: the largest at or
 *  below the theme's at which all of its slides fit, never below its floor.
 *  Cached, and a second ask while one is measuring joins it. */
export function fitSongSize(song: ResolvedSong, theme: SongTheme, aspect: number): Promise<SongFit> {
  const key = fitKey(song, theme, aspect);
  const known = sizes.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = measure(song, theme, aspect)
      .then((size) => {
        remember(key, size);
        return size;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** `fitSongSize` as a hook: `null` until measured (a frame or two the first
 *  time, nothing after). */
export function useSongFit(song: ResolvedSong | null, theme: SongTheme | null): SongFit | null {
  const displays = useDisplayStore((s) => s.displays);
  const displayId = useDisplayStore((s) => s.displayId);
  const aspect = measureAspect(displays, displayId);
  const key = useMemo(() => (song && theme ? fitKey(song, theme, aspect) : null), [song, theme, aspect]);
  const [measured, setMeasured] = useState<{ key: string; fit: SongFit } | null>(null);
  const cached = key === null ? undefined : sizes.get(key);

  useEffect(() => {
    if (key === null || !song || !theme || sizes.has(key)) return;
    let alive = true;
    void fitSongSize(song, theme, aspect).then((fit) => {
      if (alive) setMeasured({ key, fit });
    });
    return () => {
      alive = false;
    };
  }, [aspect, key, song, theme]);

  return cached ?? (measured?.key === key ? measured.fit : null);
}
