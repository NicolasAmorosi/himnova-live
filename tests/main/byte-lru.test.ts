/**
 * A deck's fonts and metafiles were converted on main once per window asking (control, projector, stage, NDI):
 * ~330 ms of fonts per window over a video of the engine on air. Kept by the file's stamp and the part, four asks are
 * one conversion (2026-11-15 audit, A11).
 */
import { expect, test } from "vitest";
import { byteLru } from "../../src/main/protocol/byte-lru";

test("four windows asking for the same part convert it once", () => {
  let conversions = 0;
  const parts = byteLru<Uint8Array>(1024, (body) => body.byteLength);
  const convert = () => {
    conversions += 1;
    return new Uint8Array(100);
  };
  const served = [1, 2, 3, 4].map(() => parts("deck.pptx\n10\n5\nfont\nppt/fonts/font1.fntdata", convert));
  expect(conversions).toBe(1);
  expect(new Set(served).size).toBe(1);
});

test("past the budget the part used longest ago goes, and one larger than the budget is never kept", () => {
  let conversions = 0;
  const parts = byteLru<Uint8Array>(250, (body) => body.byteLength);
  const ask = (key: string, bytes = 100) =>
    parts(key, () => {
      conversions += 1;
      return new Uint8Array(bytes);
    });
  ask("a");
  ask("b");
  ask("a"); // used again: `b` is now the oldest
  ask("c"); // 300 bytes: `b` goes
  expect(conversions).toBe(3);
  ask("a");
  ask("c");
  expect(conversions).toBe(3);
  ask("b");
  expect(conversions).toBe(4);
  ask("huge", 1000);
  ask("huge", 1000);
  expect(conversions).toBe(6);
  ask("c");
  expect(conversions).toBe(6);
});
