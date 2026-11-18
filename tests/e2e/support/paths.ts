import os from "node:os";
import path from "node:path";

/** The repository root: what `electron .` launches, with the build in `out/`. */
export const ROOT = path.resolve(import.meta.dirname, "../../..");

/** Generated once per machine by `global-setup.ts`, outside the repo. */
export const FIXTURES_DIR = path.join(os.tmpdir(), "worship-e2e-fixtures");
/** Bump when `global-setup.ts` changes what it generates. */
export const FIXTURE_VERSION = 14;

export function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/** The media engine this run plays with: the package's (`WORSHIP_E2E_EXECUTABLE`) or this checkout's. */
export function engineBinary(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const packaged = process.env["WORSHIP_E2E_EXECUTABLE"];
  if (!packaged) return path.join(ROOT, "resources/engine", `${process.platform}-${process.arch}`, `media-engine${exe}`);
  const resources = process.platform === "darwin" ? path.resolve(path.dirname(packaged), "../Resources") : path.join(path.dirname(packaged), "resources");
  return path.join(resources, "engine", `media-engine${exe}`);
}

/** The system's FFmpeg, on the PATH: the app ships none since R14 (2026-11-18). The suite makes its media with it. */
export function ffmpegBinary(): string {
  return "ffmpeg";
}
