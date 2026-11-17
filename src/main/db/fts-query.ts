/** Wraps user input into an FTS5 MATCH-safe query: each token is quoted so stray
 *  apostrophes/quotes/operators in what someone types can't produce a MATCH syntax
 *  error, then joined with implicit AND. The last token — the one still being
 *  typed on every keystroke of a live search — gets a trailing `*` for prefix
 *  matching, so "am" starts finding "amor" before the whole word is typed
 *  instead of the result set lurching once it suddenly becomes a whole word.
 *  Earlier, already-finished tokens stay exact matches to keep results precise. */
export function toFtsQuery(input: string, minLastWord = 0): string {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const quoted = (t: string) => `"${t.replace(/"/g, '""')}"`;
  // A space after the last word finishes it: every word exact, none dropped («la fe », «a mí »). Read before the
  // trim, which removes the only sign of it (2026-11-15 audit, R2 review).
  if (/\s$/.test(input)) return words.map(quoted).join(" ");
  // `minLastWord` (the Bible's, 3): a last word shorter than that, after finished ones, is left out until it grows.
  // Its prefix (`"p"*`) expands every term with that letter across all the installed versions (one FTS index, the
  // version filtered after) and blocked main 60 to 95 ms per pause in «en el p» (2026-11-15 audit, R2). An exact
  // short word would empty the list instead; the finished words keep it showing what they match.
  if (words.length > 1 && words.at(-1)!.length < minLastWord) return words.slice(0, -1).map(quoted).join(" ");
  const tokens = words.map(quoted);
  const lastIndex = tokens.length - 1;
  if (lastIndex >= 0) tokens[lastIndex] += "*";
  return tokens.join(" ");
}
