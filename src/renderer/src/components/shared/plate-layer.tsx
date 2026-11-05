import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cssFontFamily, cssSceneBackground } from "@shared/types/scene-style";
import { plateEdge, type PlateEdge, type PlatePosition } from "@shared/types/overlay";
import type { ProjectionPlate } from "@shared/types/projection";
import { sceneTextCss } from "./scene-text";

type Phase = "enter" | "leave";

const JUSTIFY: Record<PlatePosition, CSSProperties["justifySelf"]> = {
  "top-left": "start",
  "top-center": "center",
  "top-right": "end",
  "bottom-left": "start",
  "bottom-center": "center",
  "bottom-right": "end",
};

const TEXT_ALIGN: Record<PlatePosition, CSSProperties["textAlign"]> = {
  "top-left": "left",
  "top-center": "center",
  "top-right": "right",
  "bottom-left": "left",
  "bottom-center": "center",
  "bottom-right": "right",
};

/** Gap between a running banner's title and subtitle, and between one copy of
 *  its line and the next. */
const TICKER_GAP = "4cqw";

/**
 * Where a plate sits inside its edge's cell (`1 / 1`, shared with a plate on
 * its way out): justified by its position and pinned to its edge, `marginCqw`
 * in from every side. A banner stretches across the cell.
 */
function slotStyle(plate: ProjectionPlate): CSSProperties {
  return {
    gridArea: "1 / 1",
    display: "flex",
    minWidth: 0,
    padding: `${plate.style.marginCqw}cqw`,
    justifySelf: plate.kind === "banner" ? "stretch" : JUSTIFY[plate.position],
    alignSelf: plateEdge(plate.position) === "top" ? "start" : "end",
  };
}

/** The resting state and the state a plate comes from / goes to. "slide"
 *  travels past its own edge — the nearest vertical one — so it enters from
 *  off-stage instead of materializing a few pixels away. */
function keyframes(plate: ProjectionPlate): Keyframe[] {
  const shown: Keyframe = { opacity: 1, transform: "none" };
  if (plate.style.animation.style === "slide") {
    const top = plateEdge(plate.position) === "top";
    const off = `calc(${top ? "-" : ""}100% ${top ? "-" : "+"} ${plate.style.marginCqw}cqw)`;
    return [{ opacity: 1, transform: `translateY(${off})` }, shown];
  }
  return [{ opacity: 0, transform: "none" }, shown];
}

function animates(plate: ProjectionPlate): boolean {
  return plate.style.animation.style !== "none" && plate.style.animation.durationMs > 0;
}

/**
 * A running banner's line: two copies side by side, the track sliding left by
 * exactly one copy and starting over, so the tail is already coming in behind
 * the head and the loop has no seam.
 *
 * Each copy is at least as wide as the band (`--band`, measured). Without that
 * floor a short text made a copy narrower than the band, so both copies ended
 * mid-band and every lap the next one materialized in the middle of the screen
 * instead of coming in from the right edge.
 *
 * The duration is measured, not guessed: one copy's width over the speed, the
 * speed in `cqw` per second turned into pixels by a `100cqw` probe. That keeps
 * the pace constant whatever the length of the text, and equal on the
 * projector and on a monitor — both widths scale together. Re-measured when
 * the band resizes or the text changes; nothing else restarts the loop.
 */
function TickerLine({ plate }: { plate: ProjectionPlate }) {
  const { style } = plate;
  const clip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const key = JSON.stringify([plate.title, plate.subtitle, style.title, style.subtitle, style.fontFamily, style.ticker]);

  useLayoutEffect(() => {
    const element = track.current;
    const band = clip.current;
    if (!element || !band || typeof element.animate !== "function") return;
    let animation: Animation | null = null;
    const start = () => {
      animation?.cancel();
      element.style.setProperty("--band", `${band.clientWidth}px`);
      const copy = element.scrollWidth / 2;
      const pxPerSecond = ((probe.current?.offsetWidth ?? 0) / 100) * style.ticker.speedCqw;
      if (copy <= 0 || pxPerSecond <= 0) return;
      animation = element.animate([{ transform: "translateX(0)" }, { transform: `translateX(-${copy}px)` }], {
        duration: (copy / pxPerSecond) * 1000,
        iterations: Infinity,
      });
    };
    start();
    const observer = new ResizeObserver(start);
    observer.observe(band);
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is every input the loop depends on
  }, [key]);

  const line = (
    <>
      {plate.title ? <span style={sceneTextCss(style.title)}>{plate.title}</span> : null}
      {plate.subtitle ? <span style={sceneTextCss(style.subtitle)}>{plate.subtitle}</span> : null}
    </>
  );
  const copyStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: TICKER_GAP,
    paddingRight: TICKER_GAP,
    minWidth: "var(--band, 100cqw)",
    boxSizing: "border-box",
  };
  return (
    <div ref={clip} style={{ position: "relative", overflow: "hidden", width: "100%", minWidth: 0, lineHeight: 1.15 }}>
      <span aria-hidden ref={probe} style={{ position: "absolute", width: "100cqw", visibility: "hidden" }} />
      <div ref={track} style={{ display: "flex", width: "max-content", whiteSpace: "nowrap" }}>
        <div style={copyStyle}>{line}</div>
        <div aria-hidden style={copyStyle}>
          {line}
        </div>
      </div>
    </div>
  );
}

function PlateBox({
  onDone,
  onImageError,
  phase,
  plate,
}: {
  onDone?: () => void;
  onImageError?: ((url: string) => void) | undefined;
  phase: Phase;
  plate: ProjectionPlate;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Mount-only on purpose: an edit to a plate that is up re-renders its text
  // in place and must not play its entrance again.
  useLayoutEffect(() => {
    const element = ref.current;
    // jsdom has no Web Animations; a missing `animate` is a plate that simply
    // appears and disappears.
    if (!element || !animates(plate) || typeof element.animate !== "function") {
      if (phase === "leave") onDone?.();
      return;
    }
    const frames = keyframes(plate);
    const animation = element.animate(phase === "enter" ? frames : [...frames].reverse(), {
      duration: plate.style.animation.durationMs,
      easing: "ease-in-out",
      fill: "both",
    });
    if (phase === "leave") animation.onfinish = () => onDone?.();
    return () => animation.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, see above
  }, []);

  const { style } = plate;
  const banded = style.backgroundOpacity > 0;
  const banner = plate.kind === "banner";
  const ticker = banner && style.ticker.enabled;
  return (
    <div style={slotStyle(plate)}>
      <div
        ref={ref}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: "1.2cqw",
          // Kept at any band opacity: the band is dressing, the box is the
          // plate's footprint, and fading the band out must not move the text.
          padding: "0.9cqw 1.8cqw",
          fontFamily: cssFontFamily(style.fontFamily),
          maxWidth: "100%",
          ...(banner ? { width: "100%" } : {}),
        }}
      >
        {banded ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: cssSceneBackground(style.background),
              opacity: style.backgroundOpacity,
              borderRadius: `${style.cornerRadiusCqw}cqw`,
            }}
          />
        ) : null}
        {plate.imageUrl ? (
          <img
            alt=""
            onError={() => onImageError?.(plate.imageUrl!)}
            src={plate.imageUrl}
            style={{
              position: "relative",
              width: `${style.image.sizeCqw}cqw`,
              opacity: style.image.opacity,
              borderRadius: `${style.cornerRadiusCqw}cqw`,
            }}
          />
        ) : null}
        {ticker ? (
          <TickerLine plate={plate} />
        ) : plate.title || plate.subtitle ? (
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              lineHeight: 1.15,
              ...(banner ? { flex: 1, textAlign: TEXT_ALIGN[plate.position] } : {}),
            }}
          >
            {plate.title ? <p style={sceneTextCss(style.title)}>{plate.title}</p> : null}
            {plate.subtitle ? <p style={sceneTextCss(style.subtitle)}>{plate.subtitle}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Drawn = { plate: ProjectionPlate; phase: Phase };

/**
 * One edge of the stage: a single grid cell pinned to it. Only one plate is up
 * per edge (`platesCollide`), so the cell holds it alone — or, while one plate
 * replaces another, the leaving and the entering one in the same place, each
 * pinned to the edge, so the swap is a cross-over instead of the new plate
 * landing above the old one and dropping when it finishes.
 */
function EdgeStack({
  drawn,
  edge,
  renderPlate,
}: {
  drawn: readonly Drawn[];
  edge: PlateEdge;
  renderPlate: (entry: Drawn) => ReactNode;
}) {
  return <div style={{ position: "absolute", left: 0, right: 0, [edge]: 0, display: "grid" }}>{drawn.map(renderPlate)}</div>;
}

/**
 * The overlay plates, above every scene layer and outside all of them.
 *
 * Outside `SceneLayer` and outside `sceneContentKey` by design: a plate going
 * up is not a new scene, so the stage underneath never cross-fades because
 * somebody put a name on screen. Its own entrance and exit instead, per plate.
 *
 * A plate that disappears from `plates` is kept drawn — in a local list —
 * until its exit animation finishes. That is the whole reason this component
 * has state: the output says what should be up NOW, and a plate on its way
 * out is no longer in it.
 */
export function PlateLayer({
  onImageError,
  plates,
}: {
  onImageError?: ((url: string) => void) | undefined;
  plates: readonly ProjectionPlate[];
}) {
  const [leaving, setLeaving] = useState<readonly ProjectionPlate[]>([]);
  const previous = useRef(plates);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = plates;
    const isUp = (plate: ProjectionPlate) => plates.some((p) => p.id === plate.id);
    const gone = before.filter((plate) => animates(plate) && !isUp(plate));
    // One leaving copy per id, and none for a plate that is up again — or a
    // hide, show, hide within one exit would stack two copies under one key.
    setLeaving((current) => {
      const kept = current.filter((plate) => !isUp(plate) && !gone.some((g) => g.id === plate.id));
      return kept.length === current.length && gone.length === 0 ? current : [...kept, ...gone];
    });
  }, [plates]);

  // Filtered here too, not only in the effect: the render that puts a plate
  // back up runs before the effect that tidies the list.
  const stillLeaving = leaving.filter((plate) => !plates.some((p) => p.id === plate.id));
  if (plates.length === 0 && stillLeaving.length === 0) return null;

  const drawn: Drawn[] = [
    ...stillLeaving.map((plate) => ({ plate, phase: "leave" as const })),
    ...plates.map((plate) => ({ plate, phase: "enter" as const })),
  ];
  const renderPlate = ({ plate, phase }: Drawn) =>
    phase === "leave" ? (
      <PlateBox
        key={`leave-${plate.id}`}
        onDone={() => setLeaving((current) => current.filter((p) => p !== plate))}
        phase="leave"
        plate={plate}
      />
    ) : (
      <PlateBox key={plate.id} onImageError={onImageError} phase="enter" plate={plate} />
    );

  return (
    <div className="pointer-events-none absolute inset-0 z-[var(--z-raised)]">
      {(["top", "bottom"] as const).map((edge) => {
        const here = drawn.filter((entry) => plateEdge(entry.plate.position) === edge);
        return here.length > 0 ? <EdgeStack drawn={here} edge={edge} key={edge} renderPlate={renderPlate} /> : null;
      })}
    </div>
  );
}
