import { useEffect, useRef, useState } from "react";
import type { SlideModel } from "@shared/types/slide-model";
import { deckFontUrl, deckIdOfUrl, deckPartUrl } from "@shared/urls";
import { fontsChanged } from "@renderer/components/shared/slide-view/slide-metrics";

/**
 * The slide models this window has asked for, by url (`slideModelUrl`): each
 * is fetched once (immutable, like a slide image) and is only handed out once
 * its deck's embedded fonts are loaded and its pictures decoded — so a slide
 * never paints in a fallback face and then reflows, and the projector never
 * shows a picture arriving after its slide. Neighbouring slides are asked for
 * ahead of time (`OutputView`'s preload), which is what makes a change instant.
 */
const ready = new Map<string, SlideModel>();
const pending = new Map<string, Promise<SlideModel | null>>();
/** Each embedded font's load, by url: a second slide of the deck waits for the one the first started. */
const fontLoads = new Map<string, Promise<void>>();
/** The longest a model waits for its fonts and pictures. Every slide of a deck waits on its font's one load (A42), so a
 *  font or a picture whose request never ended held the whole deck on air for good (final pass of the 2026-11-15
 *  audit). What arrives later still lands; the slide is only not held for it. */
const MODEL_WARM_CAP_MS = 3000;

const resolvers = new Map<number, (part: string) => string>();

/** A part of the deck a model url belongs to: one function per deck, the same at every render, which `SlideView`'s
 *  memo compares. */
export function partResolver(modelUrl: string): (part: string) => string {
  const deckId = deckIdOfUrl(modelUrl) ?? 0;
  let resolve = resolvers.get(deckId);
  if (!resolve) resolvers.set(deckId, (resolve = (part) => deckPartUrl(deckId, part)));
  return resolve;
}

export function peekSlideModel(url: string): SlideModel | null {
  return ready.get(url) ?? null;
}

export function loadSlideModel(url: string): Promise<SlideModel | null> {
  const done = ready.get(url);
  if (done) return Promise.resolve(done);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;
  const promise = (async (): Promise<SlideModel | null> => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const model = (await response.json()) as SlideModel;
      const deckId = deckIdOfUrl(url) ?? 0;
      const named = namedFonts(model);
      await Promise.race([
        Promise.all([registerFonts(deckId, model, named.families), loadFaces(named.shorthands), warmPictures(model, partResolver(url))]),
        new Promise((resolve) => setTimeout(resolve, MODEL_WARM_CAP_MS)),
      ]);
      ready.set(url, model);
      return model;
    } catch {
      return null;
    } finally {
      pending.delete(url);
    }
  })();
  pending.set(url, promise);
  return promise;
}

/**
 * The model at `url` with the url it belongs to. While a new url loads, the
 * last ready one stays — like an `<img>` keeping its picture until the next has
 * decoded — so moving to a slide not yet warmed never flashes an empty stage.
 * One that cannot load clears the stage, like a broken `<img>`: the last slide
 * staying up would tell the operator the deck had moved when it had not.
 */
export function useSlideModel(
  url: string | null,
  onError?: () => void,
): { url: string; model: SlideModel } | null {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [shown, setShown] = useState<{ url: string; model: SlideModel } | null>(() => {
    const cached = url ? peekSlideModel(url) : null;
    return url && cached ? { url, model: cached } : null;
  });
  useEffect(() => {
    if (!url) {
      setShown(null);
      return;
    }
    const cached = peekSlideModel(url);
    if (cached) {
      setShown((prev) => (prev?.url === url ? prev : { url, model: cached }));
      return;
    }
    let alive = true;
    void loadSlideModel(url).then((loaded) => {
      if (!alive) return;
      setShown(loaded ? { url, model: loaded } : null);
      if (!loaded) onErrorRef.current?.();
    });
    return () => {
      alive = false;
    };
  }, [url]);
  // A warm model is handed out on the render that asks for it: `shown` only catches up in the effect, so the previous
  // slide was drawn once more first (2026-11-15 audit, R25).
  const cached = url && shown?.url !== url ? peekSlideModel(url) : null;
  return url && cached ? { url, model: cached } : shown;
}

/** The deck's embedded fonts this slide's text names, registered once per window. They beat an installed
 *  face of the same name, as they do in PowerPoint. A font another slide is
 *  still loading is waited for: taking «asked for» as «loaded» let a neighbour
 *  preloaded right after GO LIVE paint in the fallback face (2026-11-15 audit, A42). Every model carries the whole
 *  deck's list, and a slide waited for all of it: 24 faces decoded and loaded for a first slide that names 5, and 11
 *  for an `.odp` whose text names none of them (2026-11-23). A face no family list of the slide names can't draw it. */
async function registerFonts(deckId: number, model: SlideModel, families: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    model.fonts.filter((font) => families.has(font.family.toLowerCase())).map((font) => {
      const url = deckFontUrl(deckId, font.part);
      let load = fontLoads.get(url);
      if (!load) {
        const face = new FontFace(font.family, `url("${url}")`, {
          weight: font.style.startsWith("bold") ? "700" : "400",
          style: font.style.toLowerCase().includes("italic") ? "italic" : "normal",
        });
        const loading = face.load().then(
          (loaded) => {
            document.fonts.add(loaded);
            // Added already loaded, it fires no `loadingdone`: a slide drawn meanwhile in the fallback is told here.
            fontsChanged();
          },
          // A font Chromium rejects leaves its metric twin or fallback in place.
          () => undefined,
        );
        // Capped once for the whole deck: a load that never ends held every later slide 3 s more each (review of
        // 2026-11-16). What arrives after the cap still lands, through `fontsChanged`.
        load = Promise.race([loading, new Promise<void>((resolve) => setTimeout(resolve, MODEL_WARM_CAP_MS))]);
        fontLoads.set(url, load);
      }
      return load;
    }),
  );
}

/** Every face the model's text and charts name: as the CSS `font` shorthands `document.fonts.load` takes, and as
 *  bare family names in lower case, what an embedded font is matched by. */
function namedFonts(model: SlideModel): { shorthands: Set<string>; families: Set<string> } {
  const shorthands = new Set<string>();
  const families = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const style = `${record["italic"] === true ? "italic " : ""}${record["bold"] === true ? 700 : 400} 16px `;
      // A text run's or a bullet's CSS family list; a chart's single face.
      const font = record["font"];
      if (typeof font === "string") {
        shorthands.add(style + font);
        for (const name of font.split(",")) families.add(name.trim().replace(/^["']|["']$/g, "").toLowerCase());
      }
      const face = record["face"];
      if (typeof face === "string") {
        shorthands.add(`${style}"${face.replace(/"/g, "")}"`);
        families.add(face.replace(/"/g, "").trim().toLowerCase());
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(model.elements);
  return { shorthands, families };
}

/** Every face the model's text and charts name (a bundled twin like Carlito, Open Sans, Montserrat), loaded before
 *  the model is handed out. Measured before it arrived, a baseline (`metricsOf`) or a chart's widths were the
 *  fallback's, and a slide memoized since (`SlideView`) never measures again (2026-11-15 audit, A41). */
async function loadFaces(fonts: ReadonlySet<string>): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(
    [...fonts].map(async (font) => {
      try {
        await document.fonts.load(font);
      } catch {
        // A list the browser can't parse draws in its fallback, as before.
      }
    }),
  );
}

/** Every picture a model names, fetched and decoded into the window's memory
 *  cache, so the `<image>` elements that name them paint at once. */
async function warmPictures(model: SlideModel, resolve: (part: string) => string): Promise<void> {
  const parts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record["part"] === "string" && "crop" in record) parts.add(record["part"]);
      Object.values(record).forEach(visit);
    }
  };
  visit(model.elements);
  visit(model.background);
  await Promise.all(
    [...parts].map((part) => {
      const image = new Image();
      image.src = resolve(part);
      return image.decode().catch(() => undefined);
    }),
  );
}
