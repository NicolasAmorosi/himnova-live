/**
 * `shared/urls.ts` — the capability tokens the whole app addresses files by.
 *
 * Small functions, but they are the reason nothing in the renderer ever holds
 * a filesystem path, and the reason a thumbnail can be served `immutable`. The
 * cache-buster is the one with a history: a stable URL pinned the first
 * thumbnail ever generated for an id.
 */
import { describe, expect, test } from "vitest";
import {
  LOGO_URL,
  assetThumbUrl,
  assetThumbVersion,
  assetUrl,
  deckAudioUrl,
  engineAssetIdOfUrl,
  engineAssetUrl,
  engineClipOfUrl,
  engineClipUrl,
  isEngineUrl,
  linkedAudioUrl,
  slideThumbUrl,
  slideUrl,
} from "../../src/shared/urls";

describe("capability tokens", () => {
  test("every url addresses an id, never a path", () => {
    expect(assetUrl(42)).toBe("worship://asset/42");
    expect(slideUrl(7, 3)).toBe("worship://deck/7/3");
    expect(slideThumbUrl(7, 3)).toBe("worship://deck/7/3/thumb");
    expect(deckAudioUrl(9, "1.mp3")).toBe("worship://deck-audio/9?f=1.mp3");
    expect(linkedAudioUrl(42)).toBe("worship://linked-audio/42");
    expect(LOGO_URL).toBe("worship://logo");
  });

  test("nothing a caller passes can escape the scheme", () => {
    // Ids are numbers by type, so the path-traversal shape cannot even be
    // spelled — this is the assertion that keeps that true if the signature
    // ever loosens.
    for (const url of [assetUrl(1), slideUrl(1, 1), deckAudioUrl(1, "1.mp3"), linkedAudioUrl(1)]) {
      expect(url.startsWith("worship://")).toBe(true);
      expect(url).not.toContain("..");
      expect(url).not.toContain("file:");
    }
  });
});

describe("thumbnail cache-busting", () => {
  test("the version is the asset's bytes: size + mtime", () => {
    expect(assetThumbVersion({ sizeBytes: 1234, mtimeMs: 99 })).toBe("1234-99");
  });

  test("a row with no stat yet still yields a usable version", () => {
    expect(assetThumbVersion({ sizeBytes: null, mtimeMs: null })).toBe("0-0");
  });

  test("editing the file changes the version, and with it the url", () => {
    const before = assetThumbUrl(42, assetThumbVersion({ sizeBytes: 100, mtimeMs: 1 }));
    const after = assetThumbUrl(42, assetThumbVersion({ sizeBytes: 250, mtimeMs: 2 }));
    expect(before).not.toBe(after);
  });

  test("the version is escaped into the query string", () => {
    expect(assetThumbUrl(42, "a b&c")).toBe("worship://asset/42/thumb?v=a%20b%26c");
  });
});

test("an engine url names a library file or a deck clip, and nothing else is one", () => {
  expect(engineClipOfUrl(engineClipUrl("audio", 9))).toEqual({ kind: "audio", id: 9 });
  expect(engineClipOfUrl(engineClipUrl("video", 3))).toEqual({ kind: "video", id: 3 });
  expect(engineClipOfUrl(engineAssetUrl(9))).toBeNull();
  expect(engineAssetIdOfUrl(engineClipUrl("audio", 9))).toBeNull();
  expect([engineAssetUrl(1), engineClipUrl("audio", 1), engineClipUrl("video", 1)].every(isEngineUrl)).toBe(true);
  expect([assetUrl(1), deckAudioUrl(1, "1.wma"), linkedAudioUrl(1)].some(isEngineUrl)).toBe(false);
});
