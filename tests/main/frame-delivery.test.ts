import { afterEach, describe, expect, test, vi } from "vitest";
import { deliverFrame } from "../../src/preload/frame-delivery";

function received() {
  const frame = { close: vi.fn() };
  const texture = { getVideoFrame: vi.fn(() => frame), release: vi.fn() };
  return { frame, texture };
}

afterEach(() => vi.restoreAllMocks());

describe("a media-engine frame handed to the renderer", () => {
  test("a listener that throws still gives the texture back, and the others still get the frame", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { frame, texture } = received();
    const after = vi.fn();
    const listeners = new Set([
      () => {
        throw new Error("drawImage failed");
      },
      after,
    ]);

    expect(() => deliverFrame(listeners, texture)).not.toThrow();
    expect(after).toHaveBeenCalledWith(frame);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(texture.release).toHaveBeenCalledOnce();
  });

  test("with nobody listening the texture goes straight back, never opened", () => {
    const { texture } = received();
    deliverFrame(undefined, texture);
    deliverFrame(new Set(), texture);
    expect(texture.getVideoFrame).not.toHaveBeenCalled();
    expect(texture.release).toHaveBeenCalledTimes(2);
  });
});
