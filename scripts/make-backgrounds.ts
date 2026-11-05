/**
 * Draws the backgrounds the app ships (`resources/backgrounds/`): soft blots of
 * colour over a dark base, as stills (`<id>.webp`) and, for some, as seamless
 * loops (`<id>.mp4`). They are ours, made here from nothing but numbers, so
 * they ship under the app's own licence.
 *
 *   npx tsx scripts/make-backgrounds.ts       # from the repo root
 *
 * Each picture is computed small, in linear light, and FFmpeg scales it to
 * 1080p — a blur has no detail to lose — and adds a fixed grain, without which
 * an 8-bit gradient shows steps on a projector. A loop moves every blot on a
 * closed path whose period is the loop's length, so its last frame runs into
 * its first.
 *
 * Re-running rewrites the files; `starter-look.ts` names them by `id`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "resources", "backgrounds");
const exe = process.platform === "win32" ? ".exe" : "";
const FFMPEG = path.join(ROOT, "resources", "ffmpeg", `${process.platform}-${process.arch}`, `ffmpeg${exe}`);

const WIDTH = 384;
const HEIGHT = 216;
const LOOP_SECONDS = 20;
const FPS = 25;

/** A blot: its colour, centre (x across 16/9, y down 1), radius and weight;
 *  a loop moves it `dx`/`dy` around that centre. */
type Blot = { color: string; x: number; y: number; r: number; weight?: number; dx?: number; dy?: number };
type Look = { id: string; base: string; blots: Blot[]; loop?: boolean };

export const LOOKS: Look[] = [
  {
    id: "night",
    base: "#0a1628",
    loop: true,
    blots: [
      { color: "#1f5a8a", x: 0.35, y: 0.3, r: 0.55, dx: 0.12, dy: 0.06 },
      { color: "#123f63", x: 1.45, y: 0.8, r: 0.6, dx: 0.1, dy: 0.08 },
      { color: "#2c79ad", x: 1.05, y: 0.05, r: 0.32, weight: 0.6, dx: 0.14, dy: 0.05 },
    ],
  },
  {
    id: "sunrise",
    base: "#2a1446",
    loop: true,
    blots: [
      { color: "#d9703a", x: 1.35, y: 0.75, r: 0.6, dx: 0.1, dy: 0.06 },
      { color: "#efb25c", x: 1.7, y: 1.05, r: 0.4, weight: 0.85, dx: 0.08, dy: 0.05 },
      { color: "#8a3a6a", x: 0.3, y: 0.25, r: 0.55, dx: 0.12, dy: 0.07 },
    ],
  },
  {
    id: "ocean",
    base: "#061c27",
    loop: true,
    blots: [
      { color: "#1d6f86", x: 0.45, y: 0.65, r: 0.6, dx: 0.12, dy: 0.06 },
      { color: "#2f9c95", x: 1.45, y: 0.25, r: 0.42, weight: 0.8, dx: 0.1, dy: 0.08 },
      { color: "#0e3f5c", x: 1.1, y: 0.95, r: 0.5, dx: 0.14, dy: 0.05 },
    ],
  },
  {
    id: "dusk",
    base: "#221839",
    loop: true,
    blots: [
      { color: "#9b5d8c", x: 1.2, y: 0.4, r: 0.55, dx: 0.12, dy: 0.06 },
      { color: "#ef9f78", x: 1.7, y: 0.95, r: 0.38, weight: 0.85, dx: 0.08, dy: 0.06 },
      { color: "#4b3a7a", x: 0.25, y: 0.75, r: 0.55, dx: 0.1, dy: 0.08 },
    ],
  },
  {
    id: "forest",
    base: "#0a1d16",
    blots: [
      { color: "#2f6b4f", x: 0.5, y: 0.4, r: 0.6 },
      { color: "#7aa86b", x: 1.55, y: 0.85, r: 0.36, weight: 0.7 },
      { color: "#1c4a3a", x: 1.3, y: 0.1, r: 0.5 },
    ],
  },
  {
    id: "ember",
    base: "#140b08",
    blots: [
      { color: "#a8351a", x: 0.89, y: 1.05, r: 0.6 },
      { color: "#ee8a3c", x: 0.89, y: 1.15, r: 0.32, weight: 0.8 },
      { color: "#4d160d", x: 0.2, y: 0.2, r: 0.5 },
    ],
  },
  {
    id: "graphite",
    base: "#0f1216",
    blots: [
      { color: "#2a313b", x: 0.45, y: 0.3, r: 0.65 },
      { color: "#1d242d", x: 1.4, y: 0.85, r: 0.6 },
      { color: "#3a4452", x: 1.2, y: 0.15, r: 0.3, weight: 0.5 },
    ],
  },
  {
    id: "sky",
    base: "#0e2340",
    blots: [
      { color: "#3a6ea5", x: 0.5, y: 0.35, r: 0.6 },
      { color: "#7fb6d9", x: 1.5, y: 0.1, r: 0.36, weight: 0.75 },
      { color: "#1f4a7a", x: 1.25, y: 0.9, r: 0.5 },
    ],
  },
];

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (linear: number) => {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};
const rgb = (hex: string): [number, number, number] => [
  toLinear(parseInt(hex.slice(1, 3), 16)),
  toLinear(parseInt(hex.slice(3, 5), 16)),
  toLinear(parseInt(hex.slice(5, 7), 16)),
];

/** One frame, `t` in 0..1 of the loop, as RGB24. */
function frame(look: Look, t: number): Buffer {
  const out = Buffer.alloc(WIDTH * HEIGHT * 3);
  const base = rgb(look.base);
  const blots = look.blots.map((blot, index) => {
    const phase = 2 * Math.PI * (t + index / look.blots.length);
    return {
      color: rgb(blot.color),
      x: blot.x + (blot.dx ?? 0) * Math.sin(phase),
      y: blot.y + (blot.dy ?? 0) * Math.cos(phase),
      r2: blot.r * blot.r,
      weight: blot.weight ?? 1,
    };
  });
  const aspect = WIDTH / HEIGHT;
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const x = ((px + 0.5) / WIDTH) * aspect;
      const y = (py + 0.5) / HEIGHT;
      let [r, g, b] = base;
      for (const blot of blots) {
        const w = blot.weight * Math.exp(-((x - blot.x) ** 2 + (y - blot.y) ** 2) / blot.r2);
        r += (blot.color[0] - r) * w;
        g += (blot.color[1] - g) * w;
        b += (blot.color[2] - b) * w;
      }
      const at = (py * WIDTH + px) * 3;
      out[at] = toSrgb(r);
      out[at + 1] = toSrgb(g);
      out[at + 2] = toSrgb(b);
    }
  }
  return out;
}

/** 1080p, a fixed grain against banding, BT.709 like every HD video. */
const SCALE = "scale=1920:1080:flags=bicubic,noise=alls=4:allf=u";

function ffmpeg(args: string[], frames: Iterable<Buffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS), "-i", "-"];
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...input, ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    void (async () => {
      for (const data of frames) {
        if (!child.stdin.write(data)) await new Promise((drain) => child.stdin.once("drain", drain));
      }
      child.stdin.end();
    })();
  });
}

function* loopFrames(look: Look): Generator<Buffer> {
  const count = LOOP_SECONDS * FPS;
  for (let index = 0; index < count; index++) yield frame(look, index / count);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  for (const look of LOOKS) {
    await ffmpeg(["-vf", SCALE, "-frames:v", "1", "-c:v", "libwebp", "-quality", "92", path.join(OUT, `${look.id}.webp`)], [
      frame(look, 0),
    ]);
    if (look.loop) {
      await ffmpeg(
        [
          ...["-vf", `${SCALE},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`],
          ...["-c:v", "libx264", "-preset", "slow", "-crf", "21", "-tune", "grain", "-g", String(FPS * 2)],
          ...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart"],
          path.join(OUT, `${look.id}.mp4`),
        ],
        loopFrames(look),
      );
    }
    console.log(`✓ ${look.id}`);
  }
}

void main();
