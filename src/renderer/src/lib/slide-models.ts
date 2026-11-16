import { useEffect, useRef, useState } from "react";
import type { SlideModel } from "@shared/types/slide-model";
import { deckFontUrl, deckIdOfUrl, deckPartUrl } from "@shared/urls";

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
      await Promise.all([registerFonts(deckId, model), loadFaces(model), warmPictures(model, partResolver(url))]);
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
      setShown({ url, model: cached });
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
  return shown;
}

/** A deck's embedded fonts, registered once per window. They beat an installed
 *  face of the same name, as they do in PowerPoint. A font another slide is
 *  still loading is waited for: taking «asked for» as «loaded» let a neighbour
 *  preloaded right after GO LIVE paint in the fallback face (2026-11-15 audit, A42). */
async function registerFonts(deckId: number, model: SlideModel): Promise<void> {
  await Promise.all(
    model.fonts.map((font) => {
      const url = deckFontUrl(deckId, font.part);
      let load = fontLoads.get(url);
      if (!load) {
        const face = new FontFace(font.family, `url("${url}")`, {
          weight: font.style.startsWith("bold") ? "700" : "400",
          style: font.style.toLowerCase().includes("italic") ? "italic" : "normal",
        });
        load = face.load().then(
          (loaded) => void document.fonts.add(loaded),
          // A font Chromium rejects leaves its metric twin or fallback in place.
          () => undefined,
        );
        fontLoads.set(url, load);
      }
      return load;
    }),
  );
}

/** Every face the model's text and charts name (a bundled twin like Carlito, Open Sans, Montserrat), loaded before
 *  the model is handed out. Measured before it arrived, a baseline (`metricsOf`) or a chart's widths were the
 *  fallback's, and a slide memoized since (`SlideView`) never measures again (2026-11-15 audit, A41). */
async function loadFaces(model: SlideModel): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const fonts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const style = `${record["italic"] === true ? "italic " : ""}${record["bold"] === true ? 700 : 400} 16px `;
      // A text run's or a bullet's CSS family list; a chart's single face.
      if (typeof record["font"] === "string") fonts.add(style + record["font"]);
      if (typeof record["face"] === "string") fonts.add(`${style}"${record["face"].replace(/"/g, "")}"`);
      Object.values(record).forEach(visit);
    }
  };
  visit(model.elements);
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
