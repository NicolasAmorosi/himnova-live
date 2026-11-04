import type { AssetKind } from "@shared/constants";
import type { DecoderSupport } from "@shared/types/media";

/**
 * Which files Chromium can play as they are. The media engine plays the rest.
 *
 * Pure on purpose — no `electron`, no `child_process` — so the whole decision is
 * unit-tested against the measurements it encodes. Those were taken on
 * 2026-10-18 with Electron 44 on macOS, one generated file per container/codec
 * pair, comparing what ffprobe reported with what a `<video>` actually decoded:
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

/** What one ffprobe run says about a file, reduced to the facts that decide
 *  playback. Stored as JSON in `media_conversions.probe_json`; bump
 *  `MEDIA_PROBE_VERSION` whenever what is extracted here changes. */
export type MediaProbe = {
  /** ffprobe's `format_name`, a comma list such as `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: string;
  durationSec: number | null;
  video: VideoStreamFacts | null;
  audio: AudioStreamFacts | null;
};

export type VideoStreamFacts = {
  /** Absolute stream index in the file. */
  index: number;
  codec: string;
  pixFmt: string | null;
  width: number;
  height: number;
  /** `smpte2084` (PQ) or `arib-std-b67` (HLG) mean HDR. */
  colorTransfer: string | null;
};

export type AudioStreamFacts = {
  index: number;
  codec: string;
  channels: number;
};

export const MEDIA_PROBE_VERSION = 1;

const NATIVE_CONTAINERS = new Set(["mp4", "mov", "matroska", "webm", "ogg", "mp3", "wav", "flac", "aac"]);
const NATIVE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** PCM decoded fine in WAV, measured. In MOV only `pcm_s16le` was measured, so
 *  PCM anywhere else is converted — it costs a few seconds of audio encoding
 *  while the picture is copied untouched. */
const WAV_PCM_CODECS = new Set(["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_mulaw"]);
/** What the MP4 muxer takes without `-strict` and Chromium then plays. VP8 is
 *  missing on purpose: MP4 has no mapping for it. */

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

/**
 * ffprobe's `-print_format json -show_format -show_streams` output → the facts
 * above, or null when there is nothing a player could use.
 *
 * The first non-cover video stream and the default audio stream (else the
 * first) are what ffmpeg's own stream selection and Chromium both pick. A
 * cover picture is a video stream flagged `attached_pic` — counting it would
 * make every MP3 with album art look like an MJPEG video.
 */
export function parseProbe(raw: unknown): MediaProbe | null {
  if (!isRecord(raw) || !isRecord(raw.format) || !Array.isArray(raw.streams)) return null;
  const container = str(raw.format.format_name);
  if (!container) return null;

  const streams = raw.streams.filter(isRecord);
  const isCover = (s: Record<string, unknown>) => isRecord(s.disposition) && s.disposition.attached_pic === 1;
  const videoStream = streams.find((s) => s.codec_type === "video" && !isCover(s));
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audioStream =
    audioStreams.find((s) => isRecord(s.disposition) && s.disposition.default === 1) ?? audioStreams[0];

  const video = videoStream ? toVideoFacts(videoStream) : null;
  const audio = audioStream ? toAudioFacts(audioStream) : null;
  if (!video && !audio) return null;

  const durationSec = num(raw.format.duration) ?? num(videoStream?.duration) ?? num(audioStream?.duration);
  return { container, durationSec, video, audio };
}

function toVideoFacts(s: Record<string, unknown>): VideoStreamFacts | null {
  const index = num(s.index);
  const codec = str(s.codec_name);
  if (index === null || !codec) return null;
  return {
    index,
    codec,
    pixFmt: str(s.pix_fmt),
    width: num(s.width) ?? 0,
    height: num(s.height) ?? 0,
    colorTransfer: str(s.color_transfer),
  };
}

function toAudioFacts(s: Record<string, unknown>): AudioStreamFacts | null {
  const index = num(s.index);
  const codec = str(s.codec_name);
  if (index === null || !codec) return null;
  return { index, codec, channels: num(s.channels) ?? 2 };
}

/** Reads back what `parseProbe` wrote, field by field. A row that does not
 *  survive this is re-probed, never trusted. */
export function normalizeProbe(raw: unknown): MediaProbe | null {
  if (!isRecord(raw)) return null;
  const container = str(raw.container);
  if (!container) return null;
  const video = isRecord(raw.video) ? normalizeVideo(raw.video) : null;
  const audio = isRecord(raw.audio) ? normalizeAudio(raw.audio) : null;
  if (!video && !audio) return null;
  return { container, durationSec: num(raw.durationSec), video, audio };
}

function normalizeVideo(v: Record<string, unknown>): VideoStreamFacts | null {
  const index = num(v.index);
  const codec = str(v.codec);
  if (index === null || !codec) return null;
  return {
    index,
    codec,
    pixFmt: str(v.pixFmt),
    width: num(v.width) ?? 0,
    height: num(v.height) ?? 0,
    colorTransfer: str(v.colorTransfer),
  };
}

function normalizeAudio(a: Record<string, unknown>): AudioStreamFacts | null {
  const index = num(a.index);
  const codec = str(a.codec);
  if (index === null || !codec) return null;
  return { index, codec, channels: num(a.channels) ?? 2 };
}

function containerIs(container: string, names: ReadonlySet<string>): boolean {
  return container.split(",").some((name) => names.has(name));
}

function videoPlaysNatively(video: VideoStreamFacts, decoders: DecoderSupport): boolean {
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
    case "av1":
      return eightBit || tenBit;
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
