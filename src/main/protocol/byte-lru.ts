/**
 * A get-or-make cache in memory with a byte budget, the pattern of the PDF page cache (`rasterizer.ts`):
 * insertion-ordered, a hit moves to the end, past the budget the oldest goes. A value larger than the whole budget
 * is made and handed back, never kept.
 */
export function byteLru<T>(budgetBytes: number, sizeOf: (value: T) => number): (key: string, make: () => T) => T {
  const entries = new Map<string, { value: T; bytes: number }>();
  let total = 0;
  return (key, make) => {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    }
    const value = make();
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
}
