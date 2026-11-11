/** The 1.0 app's `settings.json` and `media_library.json`, carried over once. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import type { SettingsMap } from "../../src/shared/types/settings";
import { migrateLegacyMediaIfPresent, migrateLegacySettingsIfPresent } from "../../src/main/services/migrate-legacy-data";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-legacy-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the legacy logo is carried over once", () => {
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ logoPath: "/x/logo.png", lastFolder: "/y" }));
  const written: Partial<SettingsMap>[] = [];
  const repo = { setMany: (partial: Partial<SettingsMap>) => void written.push(partial) };
  migrateLegacySettingsIfPresent(repo, file);
  migrateLegacySettingsIfPresent(repo, file);
  // Fails if the file is not renamed: every launch would put the old logo back over the operator's.
  expect(written).toEqual([{ "logo.path": "/x/logo.png" }]);
  expect(fs.existsSync(`${file}.migrated`)).toBe(true);
});

test("the legacy library is set aside only once every kind is imported", async () => {
  const file = path.join(dir, "media_library.json");
  fs.writeFileSync(file, JSON.stringify({ videos: [{ path: "/v.mp4" }], images: [{ path: "/i.png" }], audios: [] }));
  const imported: unknown[] = [];
  await migrateLegacyMediaIfPresent(file, () => Promise.reject(new Error("disk gone")));
  // Fails if the file is renamed before (or despite) the import: an interrupted one would lose the library.
  expect(fs.existsSync(file)).toBe(true);
  await migrateLegacyMediaIfPresent(file, (paths, kind, opts) => Promise.resolve(imported.push([kind, paths, opts])));
  // Fails if a kind is skipped or lands outside the library.
  expect(imported).toEqual([
    ["video", ["/v.mp4"], { inLibrary: true }],
    ["image", ["/i.png"], { inLibrary: true }],
  ]);
  expect([fs.existsSync(file), fs.existsSync(`${file}.migrated`)]).toEqual([false, true]);
});
