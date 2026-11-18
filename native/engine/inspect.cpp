// The engine's inspect mode: what main asked of ffprobe and ffmpeg until R14 (2026-11-18), which took FFmpeg out of
// the app. One file, opened paused by libmpv with no GPU, no window and no sound out, then the process ends.
//
//   media-engine --inspect <path> [--frame <box> <atSeconds>]
//
// stdout: one JSON line with what the file holds, as mpv names it (main/media/media-compat.ts reads it):
//   {"format":"mov,mp4,m4a,3gp,3g2,mj2","duration":12.5,
//    "tracks":[{"type":"video","codec":"h264","index":0,"default":true,"albumart":false,"image":false,"channels":0}],
//    "video":{"pixfmt":"yuv420p","interlaced":false},
//    "frame":{"width":320,"height":180}}
// `video` is the first decoded picture's, absent when none was decoded: a codec this libmpv has no software decoder for
// (AV1 where it has no dav1d) or a seek that found no picture (a short MPEG-TS from 1 s). `frame` comes only
// with `--frame`, and the caller asks again from 0 when a picture from `atSeconds` did not come. After
// the line, exactly width×height×4 bytes: that picture as displayed (rotation, EXIF orientation and pixel aspect
// applied), fitted in a box×box square and never enlarged, laid on mid gray where it is transparent, BGRA rows with no
// padding and alpha 255. Main encodes the JPEG: the macOS libmpv is built without encoders.
// A file mpv cannot open: {"error":…} and exit 1.
#include <mpv/client.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <sys/resource.h>
#endif

void emit(const std::string& json);
std::string js(const std::string& s);

// What one key of an mpv map node holds, or null.
static const mpv_node* field(const mpv_node& map, const char* key) {
  if (map.format != MPV_FORMAT_NODE_MAP) return nullptr;
  for (int i = 0; i < map.u.list->num; i++)
    if (!strcmp(map.u.list->keys[i], key)) return &map.u.list->values[i];
  return nullptr;
}
static std::string text(const mpv_node& map, const char* key) {
  const mpv_node* v = field(map, key);
  return v && v->format == MPV_FORMAT_STRING ? v->u.string : "";
}
static int64_t integer(const mpv_node& map, const char* key) {
  const mpv_node* v = field(map, key);
  return v && v->format == MPV_FORMAT_INT64 ? v->u.int64 : 0;
}
static bool flag(const mpv_node& map, const char* key) {
  const mpv_node* v = field(map, key);
  return v && v->format == MPV_FORMAT_FLAG && v->u.flag;
}

static std::string property(mpv_handle* mpv, const char* name) {
  char* v = nullptr;
  if (mpv_get_property(mpv, name, MPV_FORMAT_STRING, &v) < 0 || !v) return "";
  std::string s = v;
  mpv_free(v);
  return s;
}

// The file as it loaded: its format, length and tracks.
static std::string describe(mpv_handle* mpv) {
  double duration = 0;
  bool timed = mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &duration) >= 0 && duration > 0;
  std::string json = "{\"format\":" + js(property(mpv, "file-format")) + ",\"duration\":" +
                     (timed ? std::to_string(duration) : std::string("null")) + ",\"tracks\":[";
  mpv_node list;
  if (mpv_get_property(mpv, "track-list", MPV_FORMAT_NODE, &list) >= 0) {
    if (list.format == MPV_FORMAT_NODE_ARRAY) {
      for (int i = 0; i < list.u.list->num; i++) {
        const mpv_node& t = list.u.list->values[i];
        // A file next to this one (an .srt, an audio file with the same name) is not part of it.
        if (flag(t, "external")) continue;
        if (json.back() != '[') json += ',';
        json += "{\"type\":" + js(text(t, "type")) + ",\"codec\":" + js(text(t, "codec")) +
                ",\"index\":" + std::to_string(integer(t, "ff-index")) +
                ",\"default\":" + (flag(t, "default") ? "true" : "false") +
                ",\"albumart\":" + (flag(t, "albumart") ? "true" : "false") +
                ",\"image\":" + (flag(t, "image") ? "true" : "false") +
                ",\"channels\":" + std::to_string(integer(t, "demux-channel-count")) + "}";
      }
    }
    mpv_free_node_contents(&list);
  }
  return json + "]";
}

int inspectMain(int argc, char** argv) {
  std::string path = argv[2];
  int box = 0;
  std::string at = "0";
  if (argc > 5 && !strcmp(argv[3], "--frame")) box = atoi(argv[4]), at = argv[5];

  // Never at the cost of what is on air: the engine playing it is a process like this one, and four of these decoding
  // a 4K HEVC froze it for up to 1.8 s on Windows (2026-11-18). Set before libmpv starts its threads, which inherit it.
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN);  // CPU, disk and memory
#elif defined(__APPLE__)
  setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG);  // the efficiency cores, and a throttled disk
#else
  setpriority(PRIO_PROCESS, 0, 19);
#endif

  mpv_handle* mpv = mpv_create();
  if (!mpv) { emit("{\"error\":\"mpv_create\"}"); return 1; }
  // No output of any kind, nothing loaded beside the file and nothing it points at (as in engine.cpp: S1 of the
  // 2026-11-15 audit), and no cover art shown as a picture: an MP3's is a track flagged `albumart`, not a video.
  const char* opts[][2] = {{"vo", "null"}, {"ao", "null"}, {"pause", "yes"}, {"keep-open", "yes"}, {"idle", "yes"},
                           {"sid", "no"}, {"hwdec", "no"}, {"config", "no"}, {"terminal", "no"}, {"load-scripts", "no"},
                           {"ytdl", "no"}, {"osc", "no"}, {"input-default-bindings", "no"}, {"sub-auto", "no"},
                           {"audio-file-auto", "no"}, {"audio-display", "no"}, {"access-references", "no"},
                           {"vd-lavc-threads", "1"}};
  for (auto& o : opts) mpv_set_option_string(mpv, o[0], o[1]);
  // Only a real start: any `start`, 0 too, is a seek, and an MPEG-TS seek decoded no picture at all.
  if (atof(at.c_str()) > 0) mpv_set_option_string(mpv, "start", at.c_str());
  // Shrunk by mpv, before the picture is turned upright: a 4000×3000 photo held upright comes out 240×320.
  // Then laid on mid gray, where it is transparent (the owner, 2026-11-18): the screenshot has no alpha, and on black a
  // dark logo vanished, on white a white one. c·α + 127.5·(1−α): premultiplied, plus half the inverted alpha. Filters
  // FFmpeg 4.4 (Ubuntu 22.04) has; a picture with no alpha comes through unchanged. And no alpha left at the end: that
  // inverted alpha is 0 where the picture is opaque, and mpv 0.34 (Ubuntu 22.04) applied it to the screenshot, which
  // turned every photo and video black there; newer ones drop it.
  std::string fit = "lavfi=[scale=w='min(" + std::to_string(box) + ",iw)':h='min(" + std::to_string(box) +
                    ",ih)':force_original_aspect_ratio=decrease,format=rgba,premultiply=inplace=1,lutrgb=a=negval," +
                    "colorchannelmixer=ra=0.5:ga=0.5:ba=0.5,format=rgb24]";
  if (box > 0) mpv_set_option_string(mpv, "vf", fit.c_str());
  mpv_request_log_messages(mpv, "error");
  if (mpv_initialize(mpv) < 0) { emit("{\"error\":\"mpv_initialize\"}"); return 1; }
  const char* load[] = {"loadfile", path.c_str(), nullptr};
  mpv_command_async(mpv, 0, load);

  // A file that never decodes a picture (a broken track, a codec FFmpeg lacks) is answered with what loaded.
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  std::string json, lastError;
  bool loaded = false, decoded = false;
  while (std::chrono::steady_clock::now() < deadline) {
    mpv_event* ev = mpv_wait_event(mpv, 0.25);
    if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
      auto* lm = (mpv_event_log_message*)ev->data;
      lastError = std::string("[") + lm->prefix + "] " + lm->text;
      while (!lastError.empty() && lastError.back() == '\n') lastError.pop_back();
      fprintf(stderr, "%s\n", lastError.c_str());
    } else if (ev->event_id == MPV_EVENT_FILE_LOADED) {
      json = describe(mpv);
      loaded = true;
      // Nothing to decode: an audio file (its cover is not shown, `audio-display=no`).
      if (property(mpv, "vid") == "no") break;
    } else if (ev->event_id == MPV_EVENT_PLAYBACK_RESTART && loaded) {
      decoded = true;
      break;
    } else if (ev->event_id == MPV_EVENT_END_FILE || ev->event_id == MPV_EVENT_SHUTDOWN) {
      break;
    }
  }
  if (!loaded) {
    emit("{\"error\":" + js(lastError.empty() ? "the file could not be opened" : lastError) + "}");
    mpv_terminate_destroy(mpv);
    return 1;
  }

  std::vector<uint8_t> pixels;
  int width = 0, height = 0;
  if (decoded) {
    // The decoder's own output, before the scale above: the file's pixel format, as ffprobe gave it.
    std::string interlaced = property(mpv, "video-frame-info/interlaced");
    json += ",\"video\":{\"pixfmt\":" + js(property(mpv, "video-dec-params/pixelformat")) + ",\"interlaced\":" + (interlaced == "yes" ? "true" : "false") + "}";
    mpv_node shot;
    const char* raw[] = {"screenshot-raw", "video", nullptr};
    if (box > 0 && mpv_command_ret(mpv, raw, &shot) >= 0) {
      width = (int)integer(shot, "w");
      height = (int)integer(shot, "h");
      int64_t stride = integer(shot, "stride");
      const mpv_node* data = field(shot, "data");
      // bgr0, the only format mpv 0.34 gives: alpha is padding, set opaque here.
      if (width > 0 && height > 0 && stride >= width * 4 && data && data->format == MPV_FORMAT_BYTE_ARRAY &&
          data->u.ba->size >= (size_t)(stride * (height - 1) + width * 4)) {
        pixels.resize((size_t)width * height * 4);
        for (int y = 0; y < height; y++) {
          const uint8_t* row = (const uint8_t*)data->u.ba->data + stride * y;
          uint8_t* out = pixels.data() + (size_t)width * 4 * y;
          memcpy(out, row, (size_t)width * 4);
          for (int x = 0; x < width; x++) out[x * 4 + 3] = 255;
        }
      }
      mpv_free_node_contents(&shot);
    }
  }
  if (!pixels.empty()) json += ",\"frame\":{\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) + "}";
  emit(json + "}");
  if (!pixels.empty()) {
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);  // or every 0x0a byte of the picture becomes 0x0d 0x0a
#endif
    fwrite(pixels.data(), 1, pixels.size(), stdout);
    fflush(stdout);
  }
  mpv_terminate_destroy(mpv);
  return 0;
}
