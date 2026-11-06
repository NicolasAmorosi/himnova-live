import { useEffect, useState } from "react";
import { isSafeFontFamily } from "@shared/types/scene-style";

/** One entry of the Local Font Access API. Only `family` matters here — a
 *  scene stores a family and lets the weight come from `SceneStyle`. */
type FontData = { family: string; fullName: string; postscriptName: string; style: string };

declare global {
  interface Window {
    /** Local Font Access API. Optional on the type because it is optional in
     *  reality: it is a permission-gated API, and a build or a platform
     *  without it must degrade rather than throw. */
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>;
  }
}

export type LocalFonts =
  | { status: "loading" }
  /** The API answered. `families` is deduplicated, sorted, and only names a style may store. */
  | { status: "ready"; families: readonly string[] }
  /** No API, or it refused. The editor keeps whatever family the scene already
   *  names and simply cannot offer a list — which is a smaller lie than an
   *  empty list, since an empty list reads as "this machine has no fonts". */
  | { status: "unavailable" };

/**
 * The font families installed on this machine.
 *
 * Asked for once per mount of the editor rather than at boot: it is a
 * permission-gated call that walks the system's font directory, and nothing
 * outside the scene editor has any use for the answer.
 *
 * Never throws and never leaves the caller in `loading`: `queryLocalFonts` can
 * be absent (a platform or a build without the API) or reject (a permission
 * the operator denied), and a font picker that spins forever would be worse
 * than one that says it cannot list them. `cssFontFamily()` already falls back
 * to the app's Noto Sans for a family that is not installed, so the failure
 * mode here is cosmetic by construction.
 */
export function useLocalFonts(enabled: boolean): LocalFonts {
  const [state, setState] = useState<LocalFonts>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    const query = window.queryLocalFonts;
    if (typeof query !== "function") {
      setState({ status: "unavailable" });
      return;
    }
    let alive = true;
    void query()
      .then((fonts) => {
        if (!alive) return;
        // One entry per FAMILY: the API returns a row per face, so a font with
        // eight weights would otherwise appear eight times. And only families
        // a style may store (`isSafeFontFamily`): «Mom's Typewriter» is a real
        // font, and offering it made every editor fail on save.
        const families = [...new Set(fonts.map((font) => font.family))]
          .filter(isSafeFontFamily)
          .sort((a, b) => a.localeCompare(b));
        setState({ status: "ready", families });
      })
      .catch((error: unknown) => {
        console.warn("[fonts] queryLocalFonts failed", error);
        if (alive) setState({ status: "unavailable" });
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return state;
}
