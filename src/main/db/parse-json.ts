/** A JSON column as `unknown`, or `null` when it does not parse. `null` is not a shape any normalizer accepts, so a
 *  broken column lands on the defaults exactly like a structurally wrong object would. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
