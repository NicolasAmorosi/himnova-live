import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The repository root: what `electron .` launches, with the build in `out/`. */
export const ROOT = path.resolve(import.meta.dirname, "../../..");

/** Generated once per machine by `global-setup.ts`, outside the repo. */
export const FIXTURES_DIR = path.join(os.tmpdir(), "worship-e2e-fixtures");
/** Bump when `global-setup.ts` changes what it generates. */
export const FIXTURE_VERSION = 8;

export function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function ffmpegBinary(): string {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(ROOT, "resources/ffmpeg", `${process.platform}-${process.arch}`, exe);
}

/** Where LibreOffice usually is. The app has its own, fuller discovery; this
 *  only decides whether the suite can build its `.pptx` fixture. */
export function findSoffice(): string | null {
  const candidates = [
    process.env["SOFFICE_PATH"],
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
  ];
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) ?? null;
}
