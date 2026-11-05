/** Wraps user input into an FTS5 MATCH-safe query: each token is quoted so stray
 *  apostrophes/quotes/operators in what someone types can't produce a MATCH syntax
 *  error, then joined with implicit AND. The last token — the one still being
 *  typed on every keystroke of a live search — gets a trailing `*` for prefix
 *  matching, so "am" starts finding "amor" before the whole word is typed
 *  instead of the result set lurching once it suddenly becomes a whole word.
 *  Earlier, already-finished tokens stay exact matches to keep results precise. */
export function toFtsQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  const lastIndex = tokens.length - 1;
  if (lastIndex >= 0) tokens[lastIndex] += "*";
  return tokens.join(" ");
}
