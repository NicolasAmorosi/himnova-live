import os from "node:os";
import path from "node:path";

/** The repository root: what `electron .` launches, with the build in `out/`. */
export const ROOT = path.resolve(import.meta.dirname, "../../..");

/** Generated once per machine by `global-setup.ts`, outside the repo. */
export const FIXTURES_DIR = path.join(os.tmpdir(), "worship-e2e-fixtures");
/** Bump when `global-setup.ts` changes what it generates. */
export const FIXTURE_VERSION = 13;

export function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function ffmpegBinary(): string {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(ROOT, "resources/ffmpeg", `${process.platform}-${process.arch}`, exe);
}
