/**
 * Puts the pinned, checksum-verified binaries the app ships next to it into
 * `resources/<kind>/<platform>-<arch>/`, which `electron-builder` ships as
 * `resources/<kind>/` (each platform's `extraResources`) and `paths.ts` reads
 * in dev:
 *
 * - `ffmpeg`: FFmpeg + ffprobe, from third-party static builds.
 * - `engine`: the media engine (`native/`) with the libmpv it ships with, from
 *   this repo's own GitHub Release `engine-<n>`, built by `native/build.sh`.
 *
 *   tsx scripts/fetch-binaries.ts                  # this machine (postinstall)
 *   tsx scripts/fetch-binaries.ts win32-x64        # a cross-build target
 *
 * Downloaded rather than versioned: the Windows FFmpeg pair alone is 210 MB.
 * Pinned by URL AND sha256, so an installer built twice ships the same bytes —
 * the same reason `package-lock.json` is committed. A target whose stamp
 * already matches is skipped, so re-running it costs nothing.
 *
 * An engine built here with `native/build.sh` leaves a `.local` marker and is
 * kept as it is: whoever changes `native/` tests their own build. Delete the
 * folder to go back to the published one.
 *
 * Publishing a new engine (`engine-<n+1>`, asked of the owner first):
 * `native/build.sh <target>` for each target, `native/build.sh pack`, a
 * pre-release NOT marked Latest (the in-app updater reads Latest) with the
 * three zips, and their sha256 below.
 *
 * The FFmpeg builds are GPLv3, mpv is GPLv2 or later, and the engine is part of
 * Himnova Live (GPL-3.0-or-later). They run as separate processes, never linked
 * into the app; each folder's `NOTICE.txt` names the sources, which is what the
 * licenses ask of a binary redistributor.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

type Archive = {
  url: string;
  sha256: string;
  /** Output file name → path inside the zip. */
  entries: Record<string, string>;
};

const RIEDL = "https://ffmpeg.martin-riedl.de/download";
const GYAN = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip";
const GYAN_ROOT = "ffmpeg-9.0.2-essentials_build";

/** FFmpeg 9.0.2 everywhere. Windows: Gyan's static "essentials" build. macOS
 *  and Linux: Martin Riedl's static builds — the macOS ones are signed with a
 *  Developer ID and the hardened runtime, which an Apple Silicon Mac requires
 *  before it will run a binary at all. */
const FFMPEG: Record<string, Archive[]> = {
  "win32-x64": [
    {
      url: GYAN,
      sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
      entries: {
        "ffmpeg.exe": `${GYAN_ROOT}/bin/ffmpeg.exe`,
        "ffprobe.exe": `${GYAN_ROOT}/bin/ffprobe.exe`,
        "LICENSE.txt": `${GYAN_ROOT}/LICENSE`,
      },
    },
  ],
  "darwin-arm64": riedl("macos/arm64/1789931890_9.0.2", {
    ffmpeg: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    ffprobe: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
  }),
  "darwin-x64": riedl("macos/amd64/1789931006_9.0.2", {
    ffmpeg: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
    ffprobe: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
  }),
  "linux-x64": riedl("linux/amd64/1789931100_9.0.2", {
    ffmpeg: "fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f",
    ffprobe: "3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32",
  }),
};

function riedl(dir: string, sums: { ffmpeg: string; ffprobe: string }): Archive[] {
  return (["ffmpeg", "ffprobe"] as const).map((name) => ({
    url: `${RIEDL}/${dir}/${name}.zip`,
    sha256: sums[name],
    entries: { [name]: name },
  }));
}

const ENGINE_RELEASE = "https://github.com/NicolasAmorosi/himnova-live/releases/download/engine-5";

/** Release `engine-5`: `native/` as of the commit its tag points at — engine-4 plus the NDI output's sound (captured
 *  from the OS), a sender that quits cleanly, deinterlacing, a first frame twice as fast and a video's sound held to
 *  meet its picture (65 ms; 40 on Windows). Linux's is built on Ubuntu 22.04 and ships no libmpv: it loads the
 *  system's, .so.2 or .so.1. */
const ENGINE: Record<string, Archive[]> = {
  "darwin-arm64": engine("darwin-arm64", "c70172ad78e1dc8157add39b246d20bb31377dd2891cd74a39c38c315eefaa11", ["media-engine", "handles.node", "libmpv.2.dylib"]),
  "win32-x64": engine("win32-x64", "d7586f980b34d8392bf6d9a82e75432f42239fe215b633499677e5b94fe6094c", ["media-engine.exe", "libmpv-2.dll"]),
  "linux-x64": engine("linux-x64", "78d1334054bbecd1b1da1493336017c5e56f9256abd5bb675d168abdaf4aca6c", ["media-engine", "handles.node"]),
};

function engine(target: string, sha256: string, files: string[]): Archive[] {
  return [
    {
      url: `${ENGINE_RELEASE}/media-engine-${target}.zip`,
      sha256,
      entries: Object.fromEntries(files.map((file) => [file, file])),
    },
  ];
}

const KINDS = [
  { kind: "ffmpeg", builds: FFMPEG, required: true },
  { kind: "engine", builds: ENGINE, required: false },
] as const;

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchTarget(kind: string, builds: Record<string, Archive[]>, required: boolean, target: string) {
  const archives = builds[target];
  if (!archives) {
    const known = `Known: ${Object.keys(builds).join(", ")}`;
    if (required) throw new Error(`No ${kind} build pinned for ${target}. ${known}`);
    // The app still runs: what only the engine plays fails like a damaged file.
    console.warn(`[${kind}] ${target}: none published, skipped. ${known}`);
    return;
  }

  const outDir = path.resolve("resources", kind, target);
  if (fs.existsSync(path.join(outDir, ".local"))) {
    console.log(`[${kind}] ${target}: local build (native/build.sh) kept`);
    return;
  }
  const stampPath = path.join(outDir, ".stamp");
  const stamp = archives.map((a) => a.sha256).join("\n");
  const expected = archives.flatMap((a) => Object.keys(a.entries));
  if (
    fs.existsSync(stampPath) &&
    fs.readFileSync(stampPath, "utf8") === stamp &&
    expected.every((name) => fs.existsSync(path.join(outDir, name)))
  ) {
    console.log(`[${kind}] ${target}: up to date`);
    return;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const archive of archives) {
    console.log(`[${kind}] ${target}: ${archive.url}`);
    const zip = await download(archive.url);
    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== archive.sha256) {
      throw new Error(`Checksum mismatch for ${archive.url}: expected ${archive.sha256}, got ${digest}`);
    }
    const wanted = new Set(Object.values(archive.entries));
    const files = unzipSync(zip, { filter: (file) => wanted.has(file.name) });
    for (const [name, entry] of Object.entries(archive.entries)) {
      const data = files[entry];
      if (!data) throw new Error(`${entry} is missing from ${archive.url}`);
      const dest = path.join(outDir, name);
      fs.writeFileSync(dest, data);
      if (!name.endsWith(".txt")) fs.chmodSync(dest, 0o755);
    }
  }
  fs.copyFileSync(path.resolve("resources", `${kind}-NOTICE.txt`), path.join(outDir, "NOTICE.txt"));
  // Last, so an interrupted download is never mistaken for a finished one.
  fs.writeFileSync(stampPath, stamp);
  console.log(`[${kind}] ${target}: ready in ${path.relative(process.cwd(), outDir)}`);
}

const targets = process.argv.slice(2);
for (const target of targets.length > 0 ? targets : [`${process.platform}-${process.arch}`]) {
  for (const { kind, builds, required } of KINDS) await fetchTarget(kind, builds, required, target);
}
