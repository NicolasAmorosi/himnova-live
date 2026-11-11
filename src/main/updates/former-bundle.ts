import path from "node:path";

/** The product was «Lumina Live» up to 2.7.2. On macOS the update opens the `.dmg` and the user drags
 *  «Himnova Live.app» into Applications: the names differ, so Finder never offers «Replace» and the old
 *  bundle stays next to the new one — and, opened by mistake, would run a 2.7 build over this profile's
 *  newer database. Same `appId`, so it is ours (owner, 2026-11-11: to the Trash, with a word). */
export const FORMER_BUNDLE = "Lumina Live.app";
/** Where the old bundle would sit: next to the running one. `null` when this executable isn't inside a
 *  `.app` (dev, tests) or IS that bundle. Pure. */
export function formerBundlePath(exePath: string): string | null {
  const bundle = path.resolve(exePath, "..", "..", "..");
  if (!bundle.endsWith(".app") || path.basename(bundle) === FORMER_BUNDLE) return null;
  return path.join(path.dirname(bundle), FORMER_BUNDLE);
}
