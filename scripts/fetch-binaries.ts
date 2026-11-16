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
 * folder to go back to the published one. `--release` (every `package:*` but
 * `package:dir`) keeps it only when it is byte for byte the pinned one.
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

const ENGINE_RELEASE = "https://github.com/NicolasAmorosi/himnova-live/releases/download/engine-8";

/** Release `engine-8`: `native/` as of the commit its tag points at. engine-7 plus protocol 8: a `hello` handshake (an
 *  older engine gets none of the new commands), each session's audio output (`device`, `devices`) with a lost output
 *  reported as `audio-out` instead of a broken file, a pre-volume peak `level` per channel for the audio strips' meters,
 *  every file played out as float stereo (mono at full level on both sides, a 5.1 downmix that never clips), and the NDI
 *  sound captured from LIVE's own output (`--audio-device`, `--preview-apart`), coming back by itself when it stops.
 *  Linux's is built on Ubuntu 22.04 and ships no libmpv: it loads the system's, .so.2 or .so.1. */
const ENGINE: Record<string, Archive[]> = {
  "darwin-arm64": engine("darwin-arm64", "9481ceb361c1d6db24a925acc4b0ae77b80884784272c9e920736eb8990ab321", ["media-engine", "handles.node", "libmpv.2.dylib"]),
  "win32-x64": engine("win32-x64", "27be9bfe2fe8bf76337888bea6f218490ebc19b391cf17250523d33fb65c37e5", ["media-engine.exe", "libmpv-2.dll"]),
  "linux-x64": engine("linux-x64", "bcbf8faa68d8baa7c8cc6a6f57012fc85079781e1a508806a77f7fd9b12f62a6", ["media-engine", "handles.node"]),
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
    if (RELEASE) {
      const differs = await differsFromPinned(archives, outDir);
      if (differs.length > 0 && process.env["ALLOW_LOCAL_ENGINE"] !== "1")
        throw new Error(
          `[${kind}] ${target}: the local build is not the pinned one (${differs.join(", ")}). Publish it and pin it, ` +
            `delete the folder to package the pinned one, or ALLOW_LOCAL_ENGINE=1 to package it anyway.`,
        );
      if (differs.length > 0) console.warn(`[${kind}] ${target}: local build NOT the pinned one, packaged anyway`);
    }
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

/** The files of a local build that are not byte for byte the pinned archive's (missing ones included). */
async function differsFromPinned(archives: Archive[], outDir: string): Promise<string[]> {
  const differs: string[] = [];
  for (const archive of archives) {
    const zip = await download(archive.url);
    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== archive.sha256) throw new Error(`Checksum mismatch for ${archive.url}: expected ${archive.sha256}, got ${digest}`);
    const wanted = new Set(Object.values(archive.entries));
    const files = unzipSync(zip, { filter: (file) => wanted.has(file.name) });
    for (const [name, entry] of Object.entries(archive.entries)) {
      const local = path.join(outDir, name);
      const pinned = files[entry];
      if (!pinned || !fs.existsSync(local) || !fs.readFileSync(local).equals(pinned)) differs.push(name);
    }
  }
  return differs;
}

// `package:*` pass `--release`: a package ships what is pinned. A local build (`native/build.sh`) is kept only when it is
// byte for byte the published one: an engine rebuilt after publishing, or `build.sh pack` zipping a folder that was not
// rebuilt, left an installer with an engine nobody published and no error (2026-11-15 audit, X23).
const RELEASE = process.argv.includes("--release");
const targets = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
for (const target of targets.length > 0 ? targets : [`${process.platform}-${process.arch}`]) {
  for (const { kind, builds, required } of KINDS) await fetchTarget(kind, builds, required, target);
}
