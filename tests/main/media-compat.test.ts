/**
 * `media-compat` — which files Chromium plays as they are. The media engine
 * plays the rest (`engine-assets.ts`).
 *
 * Every native/engine expectation below is a measurement, not an opinion:
 * the same container/codec pair was generated with ffmpeg on 2026-10-18 and
 * played in Electron 44's `<video>`, comparing decoded frames and audio bytes.
 * The silent cases (picture with no sound, sound over black) are the ones that
 * matter most, because nothing in the app would ever notice them otherwise.
 * The fixtures are the media engine's `--inspect` line, in the names mpv gave
 * for each of those pairs on 2026-11-18 (`mkv`, `yuv420p10`, `albumart`).
 */
import { describe, expect, test } from "vitest";
import { normalizeProbe, parseProbe, playsNatively, playsOnEngine } from "../../src/main/media/media-compat";
import type { DecoderSupport } from "../../src/shared/types/media";

const MAC: DecoderSupport = { hevc: true, hevcMain10: true };
const NO_HEVC: DecoderSupport = { hevc: false, hevcMain10: false };

type TrackSpec = { type: string; codec: string; pixfmt?: string; interlaced?: boolean; albumart?: boolean };

/** The engine's `--inspect` line (`native/engine/inspect.cpp`): the tracks, and the first picture's facts as the
 *  first video track that is not cover art decoded them. */
function inspect(format: string, ...tracks: TrackSpec[]): unknown {
  const picture = tracks.find((t) => t.type === "video" && !t.albumart);
  return {
    format,
    duration: 3,
    tracks: tracks.map(({ pixfmt: _p, interlaced: _i, ...t }, index) => ({
      index,
      default: true,
      albumart: false,
      image: false,
      channels: t.type === "audio" ? 2 : 0,
      ...t,
    })),
    ...(picture ? { video: { pixfmt: picture.pixfmt, interlaced: picture.interlaced ?? false } } : {}),
  };
}

const v = (codec: string, pixfmt = "yuv420p", extra: Partial<TrackSpec> = {}): TrackSpec => ({
  type: "video",
  codec,
  pixfmt,
  ...extra,
});
const a = (codec: string): TrackSpec => ({ type: "audio", codec });

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";
/** mpv's own Matroska demuxer, for .mkv and .webm alike: ffprobe's `matroska,webm`. */
const MKV = "mkv";

function native(raw: unknown, kind: "video" | "audio" = "video", decoders = MAC): boolean {
  const probe = parseProbe(raw);
  if (!probe) throw new Error("unparseable fixture");
  return playsNatively(probe, kind, decoders);
}

describe("playsNatively — what Chromium already plays", () => {
  test.each([
    ["mp4 h264 + aac", inspect(MP4, v("h264"), a("aac"))],
    ["mov h264 + aac", inspect(MP4, v("h264"), a("aac"))],
    ["mkv h264 + aac", inspect(MKV, v("h264"), a("aac"))],
    ["mkv vp9 + opus", inspect(MKV, v("vp9"), a("opus"))],
    ["webm vp8 + opus", inspect(MKV, v("vp8"), a("opus"))],
    ["mp4 av1 + aac", inspect(MP4, v("av1"), a("aac"))],
    ["mp4 h264 + mp3", inspect(MP4, v("h264"), a("mp3"))],
    ["mp4 h264 + flac", inspect(MP4, v("h264"), a("flac"))],
    ["mp4 h264, no audio", inspect(MP4, v("h264"))],
    ["mp4 hevc on a machine that decodes it", inspect(MP4, v("hevc"), a("aac"))],
  ])("%s → native", (_name, raw) => {
    expect(native(raw)).toBe(true);
  });

  test.each([
    ["mp3", inspect("mp3", a("mp3"))],
    ["m4a aac", inspect(MP4, a("aac"))],
    ["flac", inspect("flac", a("flac"))],
    ["ogg vorbis", inspect("ogg", a("vorbis"))],
    ["opus", inspect("ogg", a("opus"))],
    ["adts aac", inspect("aac", a("aac"))],
    ["wav s16", inspect("wav", a("pcm_s16le"))],
    ["wav s24", inspect("wav", a("pcm_s24le"))],
    ["wav f32", inspect("wav", a("pcm_f32le"))],
    ["wav u-law", inspect("wav", a("pcm_mulaw"))],
  ])("audio %s → native", (_name, raw) => {
    expect(native(raw, "audio")).toBe(true);
  });

  test("an MP3's album art is a cover, not an MJPEG video", () => {
    const raw = inspect("mp3", a("mp3"), { ...v("mjpeg"), albumart: true });
    expect(native(raw, "audio")).toBe(true);
    expect(parseProbe(raw)?.video).toBeNull();
  });

  test("an audio asset ignores a picture stream nobody flagged as a cover", () => {
    expect(native(inspect(MP4, a("aac"), v("mjpeg")), "audio")).toBe(true);
  });
});

describe("playsNatively — what the media engine plays", () => {
  test.each([
    // Container only: every stream is fine.
    ["avi h264 + mp3", inspect("avi", v("h264"), a("mp3"))],
    ["flv h264 + aac", inspect("flv", v("h264"), a("aac"))],
    ["ts h264 + aac", inspect("mpegts", v("h264"), a("aac"))],
    // Picture Chromium cannot decode.
    ["avi xvid + mp3", inspect("avi", v("mpeg4"), a("mp3"))],
    ["avi mjpeg + pcm", inspect("avi", v("mjpeg"), a("pcm_s16le"))],
    ["wmv", inspect("asf", v("wmv2"), a("wmav2"))],
    ["mpg mpeg2 + mp2", inspect("mpeg", v("mpeg2video"), a("mp2"))],
    ["vob mpeg2 + ac3", inspect("mpeg", v("mpeg2video"), a("ac3"))],
    // The silent ones: they open, and play only half.
    ["mp4 mpeg4 part 2 (sound over black)", inspect(MP4, v("mpeg4"), a("aac"))],
    ["mov prores (sound over black)", inspect(MP4, v("prores", "yuv422p10"), a("pcm_s16le"))],
    ["mov dnxhd (sound over black)", inspect(MP4, v("dnxhd", "yuv422p"), a("pcm_s16le"))],
    ["ogv theora (sound over black)", inspect("ogg", v("theora"), a("vorbis"))],
    ["mp4 h264 + ac3 (picture, no sound)", inspect(MP4, v("h264"), a("ac3"))],
    ["mkv h264 + dts (picture, no sound)", inspect(MKV, v("h264"), a("dts"))],
    ["m4v h264 + alac (picture, no sound)", inspect(MP4, v("h264"), a("alac"))],
    // Not safe on the church's Windows hardware decoders.
    ["h264 4:2:2", inspect(MP4, v("h264", "yuv422p"), a("aac"))],
    ["h264 High 10", inspect(MP4, v("h264", "yuv420p10"), a("aac"))],
  ])("%s → engine", (_name, raw) => {
    expect(native(raw)).toBe(false);
  });

  test("HEVC goes to the engine only where this GPU cannot decode it", () => {
    const hevc = inspect(MP4, v("hevc"), a("aac"));
    expect(native(hevc, "video", MAC)).toBe(true);
    expect(native(hevc, "video", NO_HEVC)).toBe(false);

    const hevc10 = inspect(MP4, v("hevc", "yuv420p10"), a("aac"));
    expect(native(hevc10, "video", { hevc: true, hevcMain10: false })).toBe(false);
  });

  test.each([
    ["wma", inspect("asf", a("wmav2"))],
    ["aiff", inspect("aiff", a("pcm_s16be"))],
    ["ac3", inspect("ac3", a("ac3"))],
    ["m4a alac", inspect(MP4, a("alac"))],
    ["mp2 in an .mp3", inspect("mp3", a("mp2"))],
    ["wav adpcm", inspect("wav", a("adpcm_ms"))],
    ["pcm outside a wav", inspect(MP4, a("pcm_s16le"))],
  ])("audio %s → engine", (_name, raw) => {
    expect(native(raw, "audio")).toBe(false);
  });
});

describe("playsOnEngine: every picture on Windows, where the stage's animations froze Chromium's video", () => {
  const engine = (raw: unknown, kind: "video" | "audio", everyPicture: boolean): boolean => {
    const probe = parseProbe(raw);
    if (!probe) throw new Error("unparseable fixture");
    return playsOnEngine(probe, kind, MAC, everyPicture);
  };
  const h264 = inspect(MP4, v("h264"), a("aac"));
  const wmv = inspect("asf", v("wmv3"), a("wmav2"));
  const mp3 = inspect("mp3", a("mp3"));

  test("on Windows a video Chromium plays goes to the engine; its sound alone does not", () => {
    expect(engine(h264, "video", true)).toBe(true);
    expect(engine(h264, "audio", true)).toBe(false);
    expect(engine(mp3, "audio", true)).toBe(false);
    expect(engine(inspect(MP4, a("aac")), "video", true)).toBe(false);
  });

  test("elsewhere only what Chromium cannot play goes to the engine", () => {
    expect(engine(h264, "video", false)).toBe(false);
    expect(engine(wmv, "video", false)).toBe(true);
    expect(engine(wmv, "video", true)).toBe(true);
    expect(engine(inspect("asf", a("wmav2")), "audio", true)).toBe(true);
  });
});

describe("parseProbe / normalizeProbe", () => {
  test("picks the default audio track, not just the first, and names Matroska as ffprobe did", () => {
    const raw = {
      format: "mkv",
      duration: 10.5,
      tracks: [
        { type: "video", codec: "h264", index: 0, default: false, albumart: false, image: false, channels: 0 },
        { type: "audio", codec: "ac3", index: 1, default: false, albumart: false, image: false, channels: 6 },
        { type: "audio", codec: "aac", index: 2, default: true, albumart: false, image: false, channels: 2 },
      ],
      video: { pixfmt: "yuv420p", interlaced: false },
    };
    expect(parseProbe(raw)).toEqual({
      container: "matroska,webm",
      durationSec: 10.5,
      video: { codec: "h264", pixFmt: "yuv420p", interlaced: false },
      audio: { codec: "aac" },
    });
  });

  test("mpv's pixel formats read as ffprobe's: the byte order it leaves out comes back", () => {
    expect(parseProbe(inspect(MP4, v("hevc", "yuv420p10")))?.video?.pixFmt).toBe("yuv420p10le");
    expect(parseProbe(inspect(MP4, v("prores", "yuv422p10")))?.video?.pixFmt).toBe("yuv422p10le");
    expect(parseProbe(inspect(MP4, v("h264", "yuv420p")))?.video?.pixFmt).toBe("yuv420p");
  });

  test("an AV1 the engine could not decode (a libmpv with no dav1d) is left to Chromium, which decodes it", () => {
    const raw = { format: MP4, duration: 1, tracks: [{ type: "video", codec: "av1", index: 0 }, a("aac")] };
    expect(parseProbe(raw)?.video).toEqual({ codec: "av1", pixFmt: null, interlaced: false });
    expect(native(raw)).toBe(true);
    // Any other codec with no picture read stays on the engine, as before.
    expect(native({ ...raw, tracks: [{ type: "video", codec: "h264", index: 0 }, a("aac")] })).toBe(false);
  });

  test("an interlaced H.264 in an MP4 goes to the engine, which deinterlaces it; a progressive one does not", () => {
    // A camcorder's 1080i in an .mp4: Chromium played it combed (2026-11-10 review, agent1v).
    expect(native(inspect(MP4, v("h264", "yuv420p", { interlaced: true }), a("aac")))).toBe(false);
    expect(native(inspect(MP4, v("h264", "yuv420p", { interlaced: false }), a("aac")))).toBe(true);
    expect(normalizeProbe(parseProbe(inspect(MP4, v("h264", "yuv420p", { interlaced: true }))))?.video?.interlaced).toBe(true);
  });

  test("a file with no usable stream has no probe", () => {
    expect(parseProbe({ format: "avi", tracks: [] })).toBeNull();
    expect(parseProbe({ tracks: [a("aac")] })).toBeNull();
    expect(parseProbe("garbage")).toBeNull();
  });

  test("what parseProbe writes, normalizeProbe reads back unchanged", () => {
    const probe = parseProbe(inspect("avi", v("mpeg4"), a("mp3")));
    expect(normalizeProbe(JSON.parse(JSON.stringify(probe)))).toEqual(probe);
  });

  test("a row ffprobe wrote before R14 reads back as the same facts", () => {
    const stored = {
      container: "matroska,webm",
      durationSec: 10.5,
      video: { index: 0, codec: "h264", pixFmt: "yuv420p10le", width: 1920, height: 1080, colorTransfer: null, interlaced: true },
      audio: { index: 2, codec: "aac", channels: 2 },
    };
    expect(normalizeProbe(stored)).toEqual({
      container: "matroska,webm",
      durationSec: 10.5,
      video: { codec: "h264", pixFmt: "yuv420p10le", interlaced: true },
      audio: { codec: "aac" },
    });
  });

  test("a damaged row is rejected rather than half-trusted", () => {
    expect(normalizeProbe({ container: "avi", video: { pixFmt: "yuv420p" } })).toBeNull();
    expect(normalizeProbe({ video: { codec: "mpeg4" } })).toBeNull();
    expect(normalizeProbe(null)).toBeNull();
  });
});
