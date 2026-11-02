import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { ffmpegPath, ffprobePath } from "../paths";

/**
 * The two FFmpeg executables the app ships (`scripts/fetch-ffmpeg.ts`), run as
 * child processes with an argv array — never a shell, so an accented or spaced
 * Windows path reaches them intact.
 *
 * Only probes and thumbnail frames since the media engine replaced the
 * conversion (step 1.4, 2026-11-02). Every child is tracked so
 * `killAllFfmpeg()` can end them synchronously on quit:
 * nothing asynchronous survives `before-quit`
 * (`.claude/knowledge/nothing-asynchronous-survives-before-quit.md`).
 */

const running = new Set<ChildProcess>();

/** ffprobe answers in milliseconds for a local file. Thirty seconds is a file
 *  on a sleeping network drive, not a slow probe. */
const PROBE_TIMEOUT_MS = 30_000;

export function ffmpegAvailable(): boolean {
  return fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath);
}

function track(child: ChildProcess): void {
  running.add(child);
  child.once("close", () => running.delete(child));
}

/** ffprobe's JSON for one file, or null when it cannot read it. Never throws:
 *  a file ffprobe cannot open is an answer ("leave it as it is"), not a fault. */
export function probeMedia(filePath: string): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    track(child);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * One JPEG frame, `width` px wide, for a library tile whose video the OS
 * thumbnailer cannot read (QuickLook has no AVI, WMV or MKV). One second in,
 * past the black most clips open on, and from the start for anything shorter.
 * Runs in its own process, so unlike `nativeImage` it never stalls main.
 */
export async function grabFrame(filePath: string, width: number): Promise<Buffer | null> {
  return (await grabFrameAt(filePath, width, 1)) ?? grabFrameAt(filePath, width, 0);
}

function grabFrameAt(filePath: string, width: number, atSec: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        ...["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(atSec), "-i", filePath],
        ...["-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"],
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    track(child);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      resolve(code === 0 && jpeg.length > 0 ? jpeg : null);
    });
  });
}

/** For `before-quit`: synchronous, and a plain kill is enough — ffmpeg and
 *  ffprobe start no children of their own. */
export function killAllFfmpeg(): void {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  running.clear();
}
