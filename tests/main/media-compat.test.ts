/**
 * `media-compat` — which files Chromium plays as they are. The media engine
 * plays the rest (`engine-assets.ts`).
 *
 * Every native/engine expectation below is a measurement, not an opinion:
 * the same container/codec pair was generated with ffmpeg on 2026-10-18 and
 * played in Electron 44's `<video>`, comparing decoded frames and audio bytes.
 * The silent cases (picture with no sound, sound over black) are the ones that
 * matter most, because nothing in the app would ever notice them otherwise.
 */
import { describe, expect, test } from "vitest";
import { normalizeProbe, parseProbe, playsNatively } from "../../src/main/media/media-compat";
import type { DecoderSupport } from "../../src/shared/types/media";

const MAC: DecoderSupport = { hevc: true, hevcMain10: true };
const NO_HEVC: DecoderSupport = { hevc: false, hevcMain10: false };

type StreamSpec = Record<string, unknown>;

/** The subset of `ffprobe -show_format -show_streams -print_format json` that
 *  `parseProbe` reads. */
function ffprobe(format: string, ...streams: StreamSpec[]): unknown {
  return {
    format: { format_name: format, duration: "3.000000" },
    streams: streams.map((s, index) => ({ index, disposition: { default: 1, attached_pic: 0 }, ...s })),
  };
}

const v = (codec: string, pix_fmt = "yuv420p", extra: StreamSpec = {}) => ({
  codec_type: "video",
  codec_name: codec,
  pix_fmt,
  width: 640,
  height: 360,
  ...extra,
});
const a = (codec: string, channels = 2) => ({ codec_type: "audio", codec_name: codec, channels });

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";

function native(raw: unknown, kind: "video" | "audio" = "video", decoders = MAC): boolean {
  const probe = parseProbe(raw);
  if (!probe) throw new Error("unparseable fixture");
  return playsNatively(probe, kind, decoders);
}

describe("playsNatively — what Chromium already plays", () => {
  test.each([
    ["mp4 h264 + aac", ffprobe(MP4, v("h264"), a("aac"))],
    ["mov h264 + aac", ffprobe(MP4, v("h264"), a("aac"))],
    ["mkv h264 + aac", ffprobe("matroska,webm", v("h264"), a("aac"))],
    ["mkv vp9 + opus", ffprobe("matroska,webm", v("vp9"), a("opus"))],
    ["webm vp8 + opus", ffprobe("matroska,webm", v("vp8"), a("opus"))],
    ["mp4 av1 + aac", ffprobe(MP4, v("av1"), a("aac"))],
    ["mp4 h264 + mp3", ffprobe(MP4, v("h264"), a("mp3"))],
    ["mp4 h264 + flac", ffprobe(MP4, v("h264"), a("flac"))],
    ["mp4 h264, no audio", ffprobe(MP4, v("h264"))],
    ["mp4 hevc on a machine that decodes it", ffprobe(MP4, v("hevc"), a("aac"))],
  ])("%s → native", (_name, raw) => {
    expect(native(raw)).toBe(true);
  });

  test.each([
    ["mp3", ffprobe("mp3", a("mp3"))],
    ["m4a aac", ffprobe(MP4, a("aac"))],
    ["flac", ffprobe("flac", a("flac"))],
    ["ogg vorbis", ffprobe("ogg", a("vorbis"))],
    ["opus", ffprobe("ogg", a("opus"))],
    ["adts aac", ffprobe("aac", a("aac"))],
    ["wav s16", ffprobe("wav", a("pcm_s16le"))],
    ["wav s24", ffprobe("wav", a("pcm_s24le"))],
    ["wav f32", ffprobe("wav", a("pcm_f32le"))],
    ["wav u-law", ffprobe("wav", a("pcm_mulaw"))],
  ])("audio %s → native", (_name, raw) => {
    expect(native(raw, "audio")).toBe(true);
  });

  test("an MP3's album art is a cover, not an MJPEG video", () => {
    const raw = ffprobe("mp3", a("mp3"), { ...v("mjpeg", "yuvj420p"), disposition: { attached_pic: 1 } });
    expect(native(raw, "audio")).toBe(true);
    expect(parseProbe(raw)?.video).toBeNull();
  });

  test("an audio asset ignores a picture stream nobody flagged as a cover", () => {
    expect(native(ffprobe(MP4, a("aac"), v("mjpeg", "yuvj420p")), "audio")).toBe(true);
  });
});

describe("playsNatively — what the media engine plays", () => {
  test.each([
    // Container only: every stream is fine.
    ["avi h264 + mp3", ffprobe("avi", v("h264"), a("mp3"))],
    ["flv h264 + aac", ffprobe("flv", v("h264"), a("aac"))],
    ["ts h264 + aac", ffprobe("mpegts", v("h264"), a("aac"))],
    // Picture Chromium cannot decode.
    ["avi xvid + mp3", ffprobe("avi", v("mpeg4"), a("mp3"))],
    ["avi mjpeg + pcm", ffprobe("avi", v("mjpeg", "yuvj420p"), a("pcm_s16le"))],
    ["wmv", ffprobe("asf", v("wmv2"), a("wmav2"))],
    ["mpg mpeg2 + mp2", ffprobe("mpeg", v("mpeg2video"), a("mp2"))],
    ["vob mpeg2 + ac3", ffprobe("mpeg", v("mpeg2video"), a("ac3"))],
    // The silent ones: they open, and play only half.
    ["mp4 mpeg4 part 2 (sound over black)", ffprobe(MP4, v("mpeg4"), a("aac"))],
    ["mov prores (sound over black)", ffprobe(MP4, v("prores", "yuv422p10le"), a("pcm_s16le"))],
    ["mov dnxhd (sound over black)", ffprobe(MP4, v("dnxhd", "yuv422p"), a("pcm_s16le"))],
    ["ogv theora (sound over black)", ffprobe("ogg", v("theora"), a("vorbis"))],
    ["mp4 h264 + ac3 (picture, no sound)", ffprobe(MP4, v("h264"), a("ac3"))],
    ["mkv h264 + dts (picture, no sound)", ffprobe("matroska,webm", v("h264"), a("dts"))],
    ["m4v h264 + alac (picture, no sound)", ffprobe(MP4, v("h264"), a("alac"))],
    // Not safe on the church's Windows hardware decoders.
    ["h264 4:2:2", ffprobe(MP4, v("h264", "yuv422p"), a("aac"))],
    ["h264 High 10", ffprobe(MP4, v("h264", "yuv420p10le"), a("aac"))],
  ])("%s → engine", (_name, raw) => {
    expect(native(raw)).toBe(false);
  });

  test("HEVC goes to the engine only where this GPU cannot decode it", () => {
    const hevc = ffprobe(MP4, v("hevc"), a("aac"));
    expect(native(hevc, "video", MAC)).toBe(true);
    expect(native(hevc, "video", NO_HEVC)).toBe(false);

    const hevc10 = ffprobe(MP4, v("hevc", "yuv420p10le"), a("aac"));
    expect(native(hevc10, "video", { hevc: true, hevcMain10: false })).toBe(false);
  });

  test.each([
    ["wma", ffprobe("asf", a("wmav2"))],
    ["aiff", ffprobe("aiff", a("pcm_s16be"))],
    ["ac3", ffprobe("ac3", a("ac3"))],
    ["m4a alac", ffprobe(MP4, a("alac"))],
    ["mp2 in an .mp3", ffprobe("mp3", a("mp2"))],
    ["wav adpcm", ffprobe("wav", a("adpcm_ms"))],
    ["pcm outside a wav", ffprobe(MP4, a("pcm_s16le"))],
  ])("audio %s → engine", (_name, raw) => {
    expect(native(raw, "audio")).toBe(false);
  });
});

describe("parseProbe / normalizeProbe", () => {
  test("picks the default audio track, not just the first", () => {
    const raw = {
      format: { format_name: "matroska,webm", duration: "10.5" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 },
        { index: 1, codec_type: "audio", codec_name: "ac3", channels: 6, disposition: { default: 0 } },
        { index: 2, codec_type: "audio", codec_name: "aac", channels: 2, disposition: { default: 1 } },
      ],
    };
    expect(parseProbe(raw)).toEqual({
      container: "matroska,webm",
      durationSec: 10.5,
      video: { index: 0, codec: "h264", pixFmt: "yuv420p", width: 1920, height: 1080, colorTransfer: null },
      audio: { index: 2, codec: "aac", channels: 2 },
    });
  });

  test("a file with no usable stream has no probe", () => {
    expect(parseProbe({ format: { format_name: "avi" }, streams: [] })).toBeNull();
    expect(parseProbe({ format: {}, streams: [a("aac")] })).toBeNull();
    expect(parseProbe("garbage")).toBeNull();
  });

  test("what parseProbe writes, normalizeProbe reads back unchanged", () => {
    const probe = parseProbe(ffprobe("avi", v("mpeg4"), a("mp3", 1)));
    expect(normalizeProbe(JSON.parse(JSON.stringify(probe)))).toEqual(probe);
  });

  test("a damaged row is rejected rather than half-trusted", () => {
    expect(normalizeProbe({ container: "avi", video: { codec: "mpeg4" } })).toBeNull();
    expect(normalizeProbe(null)).toBeNull();
  });
});
