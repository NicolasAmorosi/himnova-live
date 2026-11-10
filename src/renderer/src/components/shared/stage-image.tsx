import { useState, type ImgHTMLAttributes } from "react";

type StageImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> & {
  src: string;
  /** A slide: when the next one fails, the one before stays up rather than black — the deck's file
   *  gone mid-hymn (2026-11-10 review, agent5-02). The control window still says it failed. */
  holdLastGood?: boolean;
};

/**
 * Every picture on a stage — the projector's and the monitors' — drawn by an
 * `<img>` that draws NOTHING once its file failed to load: what shows instead
 * is whatever is behind it (a scene's colour, the layer's black). Chromium
 * paints a broken-image glyph in a silver frame over any sized `<img>` whose
 * file failed, `alt=""` or not, and a failure is reported to the control
 * window (`onError`), never painted where the congregation looks. A failure
 * belongs to its `src`: the next file — the next slide, in the same element —
 * is tried, and so is the failed one when it comes back.
 */
export function StageImage({ holdLastGood = false, onError, onLoad, src, ...props }: StageImageProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const [lastGood, setLastGood] = useState<string | null>(null);
  // Another file forgets the old failure, so coming back to it tries it again
  // (a drive plugged in late, a relocated file under the same address).
  if (failed !== null && failed !== src) setFailed(null);
  const shown = failed !== src ? src : holdLastGood ? lastGood : null;
  if (shown === null) return null;
  return (
    <img
      alt=""
      {...props}
      onError={(event) => {
        if (shown !== src) return;
        setFailed(src);
        onError?.(event);
      }}
      onLoad={(event) => {
        if (shown === src && holdLastGood) setLastGood(src);
        onLoad?.(event);
      }}
      src={shown}
    />
  );
}
