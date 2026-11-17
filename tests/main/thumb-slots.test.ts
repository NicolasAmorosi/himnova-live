/**
 * The library's thumbnail queue (`ThumbSlots`): the tiles on screen before the ones scrolled past. Arrival order drew
 * a whole folder's worth first, ~2 s of 300 videos on the Mac (2026-11-15 audit, R7).
 */
import { expect, test } from "vitest";
import { ThumbSlots, type Turn } from "../../src/main/media/thumb-slots";

/** One slot taken, then `asks` waiting; releases until empty: the order they started in. */
function serve(slots: ThumbSlots, waiting: [string, Turn][], between?: () => void): string[] {
  const order: string[] = [];
  for (const [name, turn] of waiting) void slots.acquire(turn).then(() => order.push(name));
  between?.();
  return order;
}

async function drain(slots: ThumbSlots, count: number): Promise<void> {
  for (let i = 0; i <= count; i += 1) {
    slots.release();
    await Promise.resolve();
  }
}

test("the newest ask goes first: the tiles on screen before the ones scrolled past", async () => {
  const slots = new ThumbSlots(1);
  await slots.acquire({ at: 0 });
  const order = serve(slots, [["top of the folder", { at: 0 }], ["middle", { at: 400 }], ["on screen", { at: 800 }]]);
  await drain(slots, 3);
  expect(order).toEqual(["on screen", "middle", "top of the folder"]);
});

test("one screenful asked at once keeps its order, top first", async () => {
  const slots = new ThumbSlots(1);
  await slots.acquire({ at: 0 });
  const order = serve(slots, [["old", { at: 0 }], ["row 1", { at: 500 }], ["row 2", { at: 510 }], ["row 3", { at: 520 }]]);
  await drain(slots, 4);
  expect(order).toEqual(["row 1", "row 2", "row 3", "old"]);
});

test("a tile scrolled back to joins the newest ask instead of waiting at the back", async () => {
  const slots = new ThumbSlots(1);
  await slots.acquire({ at: 0 });
  const back: Turn = { at: 0 };
  const order = serve(slots, [["scrolled back to", back], ["passed", { at: 400 }]], () => slots.bump(back, 900));
  await drain(slots, 2);
  expect(order).toEqual(["scrolled back to", "passed"]);
});

test("never more than the limit at once, and every waiter is served", async () => {
  const slots = new ThumbSlots(2);
  let active = 0;
  let peak = 0;
  const runs = Array.from({ length: 10 }, async (_, i) => {
    await slots.acquire({ at: i * 100 });
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    slots.release();
  });
  await Promise.all(runs);
  expect(peak).toBe(2);
});
