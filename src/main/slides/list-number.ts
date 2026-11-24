/** A list's number as lowercase roman numerals or letters (`a`..`z`, `aa`..), shared by the three slide readers. */

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"],
  [5, "v"], [4, "iv"], [1, "i"],
];

export function roman(n: number): string {
  let out = "";
  for (const [value, letters] of ROMAN) for (; n >= value; n -= value) out += letters;
  return out;
}

export function alpha(n: number): string {
  let out = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  return out;
}
