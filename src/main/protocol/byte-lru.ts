/**
 * A get-or-make cache in memory with a byte budget, the pattern of the PDF page cache (`rasterizer.ts`):
 * insertion-ordered, a hit moves to the end, past the budget the oldest goes. A value larger than the whole budget
 * is made and handed back, never kept. Asks for a key still being made wait for that same making, and a making that
 * fails is not kept.
 */
export function byteLru<T>(
  budgetBytes: number,
  sizeOf: (value: T) => number,
): (key: string, make: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { value: T; bytes: number }>();
  const making = new Map<string, Promise<T>>();
  let total = 0;
  const keep = (key: string, value: T): T => {
    const bytes = sizeOf(value);
    if (bytes > budgetBytes) return value;
    entries.set(key, { value, bytes });
    total += bytes;
    for (const [oldKey, old] of entries) {
      if (total <= budgetBytes) break;
      entries.delete(oldKey);
      total -= old.bytes;
    }
    return value;
  };
  return (key, make) => {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const pending = making.get(key);
    if (pending) return pending;
    // Set before `make` runs, and cleared however it ends: a key left here would answer a dead promise forever.
    const made = Promise.resolve()
      .then(make)
      .then((value) => keep(key, value))
      .finally(() => making.delete(key));
    making.set(key, made);
    return made;
  };
}
