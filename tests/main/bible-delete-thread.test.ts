/**
 * Deleting a Bible version runs on the Bible thread (`seed-bible-worker.ts`), not on main: the FTS trigger forgets
 * its verses one by one, ~300 ms for a whole Bible, and every media-engine frame crosses main (2026-11-15 audit, R17).
 * The thread is electron-vite's `?nodeWorker`, replaced here by one that records its job and answers.
 */
import { expect, test, vi } from "vitest";
import type { SeedBibleJob } from "../../src/main/db/seed/seed-bible-worker";

const h = vi.hoisted(() => ({
  jobs: [] as unknown[],
  deleteOnMain: vi.fn(),
  settings: new Map<string, unknown>(),
}));

vi.mock("../../src/main/paths", () => ({ dbPath: "/profile/worship.db", biblesDir: "/bibles" }));
vi.mock("../../src/main/ipc/open-dialog", () => ({ showOpenDialogFor: vi.fn() }));
vi.mock("../../src/main/services/repos", () => ({
  getBibleRepo: () => ({ deleteVersion: h.deleteOnMain }),
  getProgramsRepo: () => ({ findBibleVersionUsages: () => [] }),
  getSettingsRepo: () => ({
    get: (key: string) => h.settings.get(key) ?? null,
    setMany: (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) h.settings.set(key, value);
    },
  }),
}));
vi.mock("../../src/main/db/seed/seed-bible-worker?nodeWorker", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: ({ workerData }: { workerData: SeedBibleJob }) => {
      h.jobs.push(workerData);
      const worker = new EventEmitter();
      if ("deleteVersionId" in workerData) setTimeout(() => worker.emit("message", { deleted: workerData.deleteVersionId }));
      return worker;
    },
  };
});

const { bibleHandlers } = await import("../../src/main/ipc/handlers/bible");

test("a version is deleted on the Bible thread, and only then the default that named it is cleared", async () => {
  // Fails if main deletes it itself: 31 102 trigger runs on the thread every engine frame crosses.
  h.settings.set("bible.defaultVersionId", 7);
  h.settings.set("bible.parallelVersionId", 3);
  await bibleHandlers["bible:delete"]({ id: 7, force: false }, {} as Parameters<(typeof bibleHandlers)["bible:delete"]>[1]);
  expect(h.jobs).toHaveLength(1);
  expect(h.jobs[0]).toMatchObject({ dbPath: "/profile/worship.db", deleteVersionId: 7 });
  expect(h.deleteOnMain).not.toHaveBeenCalled();
  expect(h.settings.get("bible.defaultVersionId")).toBeNull();
  expect(h.settings.get("bible.parallelVersionId")).toBe(3);
});
