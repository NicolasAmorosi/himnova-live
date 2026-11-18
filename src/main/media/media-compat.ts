import type { AssetKind } from "@shared/constants";
import type { DecoderSupport } from "@shared/types/media";

/**
 * Which files Chromium can play as they are. The media engine plays the rest.
 *
 * Pure on purpose — no `electron`, no `child_process` — so the whole decision is
 * unit-tested against the measurements it encodes. Those were taken on
 * 2026-10-18 with Electron 44 on macOS, one generated file per container/codec
 * pair, comparing what ffprobe reported with what a `<video>` actually decoded
 * (the engine reports the same facts since R14, checked pair by pair on 2026-11-18):
 *
 * - **Containers it opens:** MP4/MOV/M4V/3GP, Matroska/WebM, Ogg, and for audio
 *   MP3, WAV, FLAC and ADTS AAC. AVI, ASF (WMV/WMA), FLV, MPEG-PS (MPG/VOB),
 *   MPEG-TS, AIFF, AC3/DTS elementary streams: `DEMUXER_ERROR_COULD_NOT_OPEN`.
 * - **The dangerous half is silent.** A ProRes, DNxHD, MJPEG, Theora or MPEG-4
 *   part 2 (Xvid/DivX) video inside an MP4/MOV plays its AUDIO over a black
 *   picture, and an AC3/E-AC3/DTS/ALAC/MP2 track plays the picture with no
 *   sound — with no `error` event in either case. That is why this reads the
 *   streams instead of trusting an extension or waiting for the element to
 *   complain.
 *
 * H.264 is only trusted in 8-bit 4:2:0. macOS decoded High 10, 4:2:2 and 4:4:4
 * fine through VideoToolbox, but hardware decoders on Windows do not take
 * them, and the church machine is Windows. HEVC is the one codec whose support
 * depends on the machine's GPU, so it is a parameter (`DecoderSupport`) rather
 * than a constant.
 */

/** What the media engine's `--inspect` says about a file (`native/engine/inspect.cpp`), reduced to the facts that
 *  decide playback and in the names the table above was measured with: ffprobe's, which is what said them until R14
 *  took FFmpeg out of the app (2026-11-18). Stored as JSON in `media_conversions.probe_json`; bump
 *  `MEDIA_PROBE_VERSION` whenever what is extracted here changes. Rows written from ffprobe read back the same. */
export type MediaProbe = {
  /** FFmpeg's demuxer name, a comma list such as `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: string;
  durationSec: number | null;
  video: VideoStreamFacts | null;
  audio: AudioStreamFacts | null;
};

export type VideoStreamFacts = {
  codec: string;
  /** FFmpeg's name (`yuv420p10le`); null when the engine decoded no picture to read it from. */
  pixFmt: string | null;
  /** Fields, not frames: a camcorder's 1080i. */
  interlaced: boolean;
};

export type AudioStreamFacts = {
  codec: string;
};

/** 2: `interlaced` (2026-11-10). */
export const MEDIA_PROBE_VERSION = 2;

const NATIVE_CONTAINERS = new Set(["mp4", "mov", "matroska", "webm", "ogg", "mp3", "wav", "flac", "aac"]);
const NATIVE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** PCM decoded fine in WAV, measured. In MOV only `pcm_s16le` was measured, so
 *  PCM anywhere else is left to the media engine. */
const WAV_PCM_CODECS = new Set(["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_mulaw"]);
/** mpv reads Matroska and WebM with a demuxer of its own; everything else is FFmpeg's, named as ffprobe names it. */
const CONTAINER_NAMES: Record<string, string> = { mkv: "matroska,webm" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** mpv names a pixel format as FFmpeg does, less the byte order of this machine: `yuv420p10` is `yuv420p10le`. And a
 *  JPEG-range `yuvj420p` is `yuv420p` to it, which the table treats alike. */
function ffmpegPixFmt(mpvName: unknown): string | null {
  const name = str(mpvName);
  return name && /^yuv.*p\d+$/.test(name) ? `${name}le` : name;
}

/**
 * The engine's `--inspect` line → the facts above, or null when there is nothing a player could use.
 *
 * The first video track that is not cover art and the default audio track (else the first), which is what mpv,
 * ffmpeg and Chromium all pick. The picture's facts are the decoded first frame's (`video`).
 */
export function parseProbe(raw: unknown): MediaProbe | null {
  if (!isRecord(raw) || !Array.isArray(raw.tracks)) return null;
  const format = str(raw.format);
  if (!format) return null;

  const tracks = raw.tracks.filter(isRecord);
  const videoTrack = tracks.find((t) => t.type === "video" && t.albumart !== true);
  const audioTracks = tracks.filter((t) => t.type === "audio");
  const audioTrack = audioTracks.find((t) => t.default === true) ?? audioTracks[0];
  const decoded = isRecord(raw.video) ? raw.video : {};

  const videoCodec = str(videoTrack?.codec);
  const audioCodec = str(audioTrack?.codec);
  const video = videoCodec
    ? { codec: videoCodec, pixFmt: ffmpegPixFmt(decoded.pixfmt), interlaced: decoded.interlaced === true }
    : null;
  const audio = audioCodec ? { codec: audioCodec } : null;
  if (!video && !audio) return null;
  return { container: CONTAINER_NAMES[format] ?? format, durationSec: num(raw.duration), video, audio };
}

/** Reads back what `parseProbe` wrote, field by field. A row that does not
 *  survive this is re-probed, never trusted. */
export function normalizeProbe(raw: unknown): MediaProbe | null {
  if (!isRecord(raw)) return null;
  const container = str(raw.container);
  if (!container) return null;
  const videoCodec = isRecord(raw.video) ? str(raw.video.codec) : null;
  const audioCodec = isRecord(raw.audio) ? str(raw.audio.codec) : null;
  const video =
    videoCodec && isRecord(raw.video)
      ? { codec: videoCodec, pixFmt: str(raw.video.pixFmt), interlaced: raw.video.interlaced === true }
      : null;
  const audio = audioCodec ? { codec: audioCodec } : null;
  if (!video && !audio) return null;
  return { container, durationSec: num(raw.durationSec), video, audio };
}

function containerIs(container: string, names: ReadonlySet<string>): boolean {
  return container.split(",").some((name) => names.has(name));
}

function videoPlaysNatively(video: VideoStreamFacts, decoders: DecoderSupport): boolean {
  // Chromium shows fields as they are, combed on every moving edge; the engine deinterlaces (2026-11-10 review).
  if (video.interlaced) return false;
  const eightBit = video.pixFmt === "yuv420p" || video.pixFmt === "yuvj420p";
  const tenBit = video.pixFmt === "yuv420p10le";
  switch (video.codec) {
    case "h264":
      return eightBit;
    case "hevc":
      return eightBit ? decoders.hevc : tenBit && decoders.hevcMain10;
    case "vp8":
      return true;
    case "vp9":
      return eightBit || tenBit;
    case "av1":
      // An unread format is AV1 the engine could not decode (a libmpv with no dav1d, as macOS's was before engine-11):
      // nearly always 4:2:0 at 8 or 10 bits, which Chromium plays with its own dav1d.
      return eightBit || tenBit || video.pixFmt === null;
    default:
      return false;
  }
}

function audioPlaysNatively(audio: AudioStreamFacts, container: string): boolean {
  if (NATIVE_AUDIO_CODECS.has(audio.codec)) return true;
  return WAV_PCM_CODECS.has(audio.codec) && containerIs(container, new Set(["wav"]));
}

/**
 * Whether Chromium plays this file as it is. What it does not, the media engine plays
 * (`engine-assets.ts`).
 *
 * An audio asset never carries a picture: whatever "video" an audio file has
 * that is not flagged as a cover is still artwork, and Chromium ignores it.
 *
 * A file with no stream at all counts as native — the engine could not play it
 * either, and the projector already reports a file it cannot open.
 */
export function playsNatively(probe: MediaProbe, kind: AssetKind, decoders: DecoderSupport): boolean {
  const video = kind === "audio" ? null : probe.video;
  const audio = probe.audio;
  if (!video && !audio) return true;
  return (
    containerIs(probe.container, NATIVE_CONTAINERS) &&
    (video === null || videoPlaysNatively(video, decoders)) &&
    (audio === null || audioPlaysNatively(audio, probe.container))
  );
}

/**
 * Windows: the media engine plays every picture, not only what Chromium cannot decode (owner, 2026-11-16). Chromium
 * paces all its windows on the primary screen's refresh, and a full-screen window on a slower screen (the stage at
 * 60 Hz beside a 200 Hz primary) that animates anything blocks Chromium's GPU thread on each present. Its video decoder
 * runs on that thread: a red stage message froze the room's video. The engine decodes in its own process.
 * `--chromium-video` keeps Chromium's path: the E2E suite's specs read a `<video>`.
 */
export const ENGINE_PLAYS_EVERY_PICTURE = process.platform === "win32" && !process.argv.includes("--chromium-video");

/** Whether the media engine plays this file: one with a picture always where `everyPicture`, else what Chromium does not. */
export function playsOnEngine(
  probe: MediaProbe,
  kind: AssetKind,
  decoders: DecoderSupport,
  everyPicture = ENGINE_PLAYS_EVERY_PICTURE,
): boolean {
  if (everyPicture && kind !== "audio" && probe.video !== null) return true;
  return !playsNatively(probe, kind, decoders);
}
