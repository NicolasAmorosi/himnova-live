/**
 * A deck's fonts and metafiles were converted on main once per window asking (control, projector, stage, NDI):
 * ~330 ms of fonts per window over a video of the engine on air. Kept by the file's stamp and the part, four asks are
 * one conversion (2026-11-15 audit, A11). Converted on their own thread since SE1, the four asks arrive while that one
 * conversion is still under way, and still meet in it.
 */
import { expect, test } from "vitest";
import { byteLru } from "../../src/main/protocol/byte-lru";

test("four windows asking for the same part convert it once", async () => {
  let conversions = 0;
  const parts = byteLru<Uint8Array>(1024, (body) => body.byteLength);
  const convert = () => {
    conversions += 1;
    return new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(new Uint8Array(100)), 10));
  };
  const key = "deck.pptx\n10\n5\nfont\nppt/fonts/font1.fntdata";
  const served = await Promise.all([1, 2, 3, 4].map(() => parts(key, convert)));
  served.push(await parts(key, convert));
  expect(conversions).toBe(1);
  expect(new Set(served).size).toBe(1);
});

test("a conversion that fails is not kept, nor waited on by the next ask", async () => {
  const parts = byteLru<Uint8Array>(1024, (body) => body.byteLength);
  await expect(parts("a", () => Promise.reject(new Error("read error")))).rejects.toThrow("read error");
  expect(await parts("a", () => Promise.resolve(new Uint8Array(1)))).toHaveLength(1);
});

test("past the budget the part used longest ago goes, and one larger than the budget is never kept", async () => {
  let conversions = 0;
  const parts = byteLru<Uint8Array>(250, (body) => body.byteLength);
  const ask = (key: string, bytes = 100) =>
    parts(key, () => {
      conversions += 1;
      return Promise.resolve(new Uint8Array(bytes));
    });
  await ask("a");
  await ask("b");
  await ask("a"); // used again: `b` is now the oldest
  await ask("c"); // 300 bytes: `b` goes
  expect(conversions).toBe(3);
  await ask("a");
  await ask("c");
  expect(conversions).toBe(3);
  await ask("b");
  expect(conversions).toBe(4);
  await ask("huge", 1000);
  await ask("huge", 1000);
  expect(conversions).toBe(6);
  await ask("c");
  expect(conversions).toBe(6);
});
