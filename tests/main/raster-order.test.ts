import { describe, expect, it } from "vitest";
import { takeNewestBurst } from "../../src/main/slides/raster-order";

const task = (name: string, at: number) => ({ name, at });

describe("takeNewestBurst", () => {
  it("serves the newest burst first, and arrival order inside it", () => {
    // Three quick presses, 80 ms apart: the slide shown, then its warm-up.
    const queue = [task("p2", 0), task("p3-warm", 5), task("p3", 80), task("p4-warm", 85), task("p4", 160), task("p5-warm", 165)];
    const order: string[] = [];
    for (let next = takeNewestBurst(queue); next; next = takeNewestBurst(queue)) order.push(next.name);
    expect(order).toEqual(["p4", "p5-warm", "p3", "p4-warm", "p2", "p3-warm"]);
  });

  it("is first-come-first-served for one ask, and empty is nothing", () => {
    const queue = [task("open", 0), task("p1", 10)];
    expect(takeNewestBurst(queue)?.name).toBe("open");
    expect(takeNewestBurst(queue)?.name).toBe("p1");
    expect(takeNewestBurst(queue)).toBeUndefined();
  });
});
