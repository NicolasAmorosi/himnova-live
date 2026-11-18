/**
 * Puts the pinned, checksum-verified media engine (`native/`, with the libmpv it
 * ships with) into `resources/engine/<platform>-<arch>/`, which `electron-builder`
 * ships as `resources/engine/` (each platform's `extraResources`) and `paths.ts`
 * reads in dev. It comes from this repo's own GitHub Release `engine-<n>`, built
 * by `native/build.sh`. FFmpeg was fetched here too until R14 (2026-11-18): the
 * engine probes files and draws thumbnails since, and the E2E suite and
 * `scripts/make-backgrounds.ts` use the system's `ffmpeg`.
 *
 *   tsx scripts/fetch-binaries.ts                  # this machine (postinstall)
 *   tsx scripts/fetch-binaries.ts win32-x64        # a cross-build target
 *
 * Downloaded rather than versioned: Windows' libmpv alone is 120 MB.
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
 * mpv is GPLv2 or later, and the engine is part of Himnova Live
 * (GPL-3.0-or-later). It runs as a separate process, never linked into the app;
 * the folder's `NOTICE.txt` names the sources, which is what the licenses ask of
 * a binary redistributor.
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

const ENGINE_RELEASE = "https://github.com/NicolasAmorosi/himnova-live/releases/download/engine-11";

/** Release `engine-11`: `native/` as of the commit its tag points at (protocol 9). engine-10 plus: an inspect mode
 *  (`--inspect`, R14) that says what a file holds and draws its thumbnail, decoding with one thread at a background
 *  priority, and dav1d in the macOS libmpv. Playback and the NDI output are engine-10's.
 *  Linux's is built on Ubuntu 22.04 and ships no libmpv: it loads the system's, .so.2 or .so.1. */
const ENGINE: Record<string, Archive[]> = {
  "darwin-arm64": engine("darwin-arm64", "029c0997c09f3d2f9fd60a214571a916e8e554af077134c62d962d42ffd137b3", ["media-engine", "handles.node", "libmpv.2.dylib"]),
  "win32-x64": engine("win32-x64", "f26168b6a8019f5d2fed3d06a7ca953c2ecc7dd6fd75a6ce11765bce72e94e75", ["media-engine.exe", "libmpv-2.dll"]),
  "linux-x64": engine("linux-x64", "23a6abd10adeeb78ea4d4ee8873e70afeac6d1c5bde116d2165b78e7c4c46647", ["media-engine", "handles.node"]),
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

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchTarget(kind: string, builds: Record<string, Archive[]>, target: string) {
  const archives = builds[target];
  if (!archives) {
    const known = `Known: ${Object.keys(builds).join(", ")}`;
    // The app still runs: what only the engine plays fails like a damaged file.
    console.warn(`[${kind}] ${target}: none published, skipped. ${known}`);
    return;
  }

  const outDir = path.resolve("resources", kind, target);
  const local = fs.existsSync(path.join(outDir, ".local"));
  const differs = local && RELEASE ? await differsFromPinned(archives, outDir) : [];
  if (local && RELEASE && differs.length > 0 && process.env["ALLOW_LOCAL_ENGINE"] !== "1")
    throw new Error(
      `[${kind}] ${target}: the local build is not the pinned one (${differs.join(", ")}). Publish it and pin it, ` +
        `delete the folder to package the pinned one, or ALLOW_LOCAL_ENGINE=1 to package it anyway.`,
    );
  if (local && RELEASE && differs.length === 0) {
    // The same bytes: the published files replace it, so the package has exactly them and their NOTICE.txt, never a
    // file the local build left beside them (review of X23).
    console.log(`[${kind}] ${target}: local build is the pinned one, replaced by the published files`);
    fs.rmSync(outDir, { recursive: true, force: true });
  } else if (local) {
    if (differs.length > 0) console.warn(`[${kind}] ${target}: local build NOT the pinned one, packaged anyway`);
    // What the licenses ask of a binary that ships, which only a download wrote.
    fs.copyFileSync(path.resolve("resources", `${kind}-NOTICE.txt`), path.join(outDir, "NOTICE.txt"));
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
  await fetchTarget("engine", ENGINE, target);
}
