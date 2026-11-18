import { spawn, type ChildProcess } from "node:child_process";
import { nativeImage } from "electron";
import { enginePath } from "../paths";
import { MEDIA_THUMB_QUALITY } from "@shared/constants";
import { engineAvailable, longPathSafe, readHead } from "./media-engine";
import { textInsteadOfMedia } from "./engine-protocol";

/**
 * The media engine's inspect mode (`native/engine/inspect.cpp`): what a file holds, and a small picture of it, each
 * asked of an engine process of its own that ends with the answer. It replaced ffprobe and ffmpeg when R14 took
 * FFmpeg out of the app (2026-11-18), and it never stalls main: the decode is the engine's, and main only encodes a
 * picture a few hundred pixels wide.
 *
 * Every child is tracked so `killAllInspections()` can end them synchronously on quit: nothing asynchronous survives
 * `before-quit` (`.claude/knowledge/nothing-asynchronous-survives-before-quit.md`).
 */

const running = new Set<ChildProcess>();

/** A local file answers in tens of milliseconds. Thirty seconds is a file on a sleeping network drive. */
const TIMEOUT_MS = 30_000;

/** An engine that died without a word (Linux with no libmpv: the AppImage on a distro without mpv) dies the same way
 *  for every file. Known after the first try, so a library of photos is not one dead process per tile. */
let cannotStart = false;

/** Whether files can be inspected here at all: false with no engine, or one that cannot start. */
export function inspectorWorks(): boolean {
  return engineAvailable() && !cannotStart;
}

type Inspection = { info: unknown; frame: { width: number; height: number; pixels: Buffer } | null };

function inspect(filePath: string, frame?: { box: number; atSec: number }): Promise<Inspection | null> {
  if (!inspectorWorks()) return Promise.resolve(null);
  return readHead(filePath).then((head) => {
    // A playlist with a video's name makes mpv load what it lists (2026-11-15 audit, S1): never handed to it.
    if (!head || textInsteadOfMedia(head)) return null;
    return new Promise<Inspection | null>((resolve) => {
      const args = ["--inspect", longPathSafe(filePath)];
      if (frame) args.push("--frame", String(frame.box), String(frame.atSec));
      const child = spawn(enginePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      running.add(child);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        running.delete(child);
        const out = Buffer.concat(chunks);
        if (code !== 0) {
          // A file it cannot open still gets its `{"error":…}` line; nothing at all is the engine itself.
          if (out.length === 0 && code === 1) cannotStart = true;
          return resolve(null);
        }
        const end = out.indexOf(10);
        let info: unknown;
        try {
          info = JSON.parse(out.subarray(0, end < 0 ? out.length : end).toString("utf8"));
        } catch {
          return resolve(null);
        }
        const size = (info as { frame?: { width?: unknown; height?: unknown } }).frame;
        const width = typeof size?.width === "number" ? size.width : 0;
        const height = typeof size?.height === "number" ? size.height : 0;
        const pixels = out.subarray(end + 1);
        resolve({
          info,
          frame: width > 0 && height > 0 && pixels.length === width * height * 4 ? { width, height, pixels } : null,
        });
      });
    });
  });
}

/** What the engine says a file holds (`media-compat.ts`'s `parseProbe` reads it), or null when it cannot read it.
 *  Never throws: a file it cannot open is an answer ("leave it as it is"), not a fault. */
export async function probeMedia(filePath: string): Promise<unknown> {
  return (await inspect(filePath))?.info ?? null;
}

/**
 * One JPEG of the picture `atSec` in, as displayed (rotation and EXIF orientation applied), fitted in a `box`×`box`
 * square and never enlarged. Null when there is no picture there: an audio file, a broken one, a seek past the end of
 * a short clip (ask again from 0), or no engine.
 */
export async function grabFrame(filePath: string, box: number, atSec: number): Promise<Buffer | null> {
  const frame = (await inspect(filePath, { box, atSec }))?.frame;
  if (!frame) return null;
  const jpeg = nativeImage.createFromBitmap(frame.pixels, { width: frame.width, height: frame.height }).toJPEG(MEDIA_THUMB_QUALITY);
  return jpeg.length > 0 ? jpeg : null;
}

/** For `before-quit`: synchronous, and a plain kill is enough, an inspecting engine starts no children. */
export function killAllInspections(): void {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  running.clear();
}
