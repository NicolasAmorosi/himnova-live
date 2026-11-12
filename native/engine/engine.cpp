// Himnova Live's media engine: one file, played by libmpv in its own process, its frames rendered into a
// ring of GPU textures that Electron main imports (`sharedTexture`) and sends to every window that shows
// it; the sound comes out of mpv itself. A crash here takes only this engine down. Main starts one
// ahead of time (it costs 150–650 ms) and then gives it a file.
//
// Protocol: one line per message. Main → engine (stdin):
//   load <startAt> <paused 0|1> <volume 0-100> <loop 0|1> <audio 0|1> <path…>   (once per engine)
//   pause 0|1 · volume <0-100> · loop 0|1 · seek <seconds> exact|keyframes · release <slot> · quit
// Engine → main (stdout), JSON:
//   {"ev":"ready","gpu":…}                          the device is up, waiting for `load`
//   {"ev":"loaded","duration":…,"width":…,"height":…,"hasVideo":…,"hasAudio":…}
//   {"ev":"slots","width":…,"height":…,"handles":[…]} the ring, made for this file's picture
//   {"ev":"frame","slot":…}                         main hands it back with `release <slot>`
//   {"ev":"status","time":…,"duration":…,"paused":…,"ended":…}   about 4 times a second, and on changes
//   {"ev":"error","code":"engine-…","detail":…}     codes: engine-gpu, engine-open, engine-args
//
// Args: [--parent <pid>] (Windows) [--fd-socket <path>] (Linux) [--max-width 1920 --max-height 1080]
//       [--slots 6] [--hwdec …] [--close-in-parent <handle,…>] (Windows: a dead engine's ring)
//       [--log-level error|warn|info|v|debug] (mpv's log on stderr; main keeps its tail for errors)
//       [--cache-dir <shader cache>]
// `--ndi-send <name> …` as the first argument runs the NDI output mode instead: see ndi.cpp.
#include <mpv/client.h>
#include <mpv/render.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "gpu.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <shellapi.h>
#ifndef PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
#define PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION 0x4
#endif
void closeInParent(unsigned long parentPid, const std::vector<unsigned long long>& handles);
#endif
int ndiSendMain(int argc, char** argv);

#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>
#include <unistd.h>

#include <cstring>

// The NDI output's sound tap (ndi-audio-mac.mm) can only add a process Core Audio already knows, and a process
// becomes known when it first plays: each new engine joined the tap 300–400 ms into its video, and that much of its
// first sound never reached NDI (measured 2026-11-12; 70–83 ms for an engine that had played before). 100 ms of
// silence on the default output when the engine starts, before any file, makes it known. Windows and Linux capture
// the process tree and lost nothing.
static void becomeKnownToCoreAudio() {
  AudioObjectID out = kAudioObjectUnknown;
  UInt32 size = sizeof out;
  AudioObjectPropertyAddress a{kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &size, &out) != noErr || out == kAudioObjectUnknown) return;
  AudioDeviceIOProcID proc = nullptr;
  auto silence = [](AudioObjectID, const AudioTimeStamp*, const AudioBufferList*, const AudioTimeStamp*, AudioBufferList* o,
                    const AudioTimeStamp*, void*) -> OSStatus {
    for (UInt32 i = 0; i < o->mNumberBuffers; i++) memset(o->mBuffers[i].mData, 0, o->mBuffers[i].mDataByteSize);
    return noErr;
  };
  if (AudioDeviceCreateIOProcID(out, silence, nullptr, &proc) != noErr) return;
  if (AudioDeviceStart(out, proc) == noErr) {
    usleep(100000);
    AudioDeviceStop(out, proc);
  }
  AudioDeviceDestroyIOProcID(out, proc);
}
#endif

static std::mutex outMutex;
// Also used by ndi.cpp, the NDI output mode.
void emit(const std::string& json) {
  std::lock_guard<std::mutex> l(outMutex);
  fputs(json.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
std::string js(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
static std::string num(double v) { char b[32]; snprintf(b, sizeof b, "%.3f", std::isfinite(v) ? v : 0.0); return b; }
static const char* boolean(bool v) { return v ? "true" : "false"; }
static void emitError(const Fail& f) { emit("{\"ev\":\"error\",\"code\":" + js(f.code) + ",\"detail\":" + js(f.detail) + "}"); }

// Which slots main still holds. The render thread waits for a free one, so a slow window costs
// frames, never memory.
struct Ring {
  std::mutex m;
  std::condition_variable cv;
  std::vector<bool> busy;
  size_t next = 0;
  bool closed = false;
  int acquire() {
    std::unique_lock<std::mutex> l(m);
    for (;;) {
      for (size_t k = 0; k < busy.size(); k++) {
        size_t i = (next + k) % busy.size();
        if (!busy[i]) { busy[i] = true; next = i + 1; return (int)i; }
      }
      if (closed) return -1;
      cv.wait_for(l, std::chrono::milliseconds(100));
    }
  }
  void reset(int n) { std::lock_guard<std::mutex> l(m); busy.assign(n, false); next = 0; }
  void release(int i) {
    { std::lock_guard<std::mutex> l(m); if (i >= 0 && (size_t)i < busy.size()) busy[i] = false; }
    cv.notify_all();
  }
  void close() { { std::lock_guard<std::mutex> l(m); closed = true; } cv.notify_all(); }
};

struct Engine {
  mpv_handle* mpv = nullptr;
  Ring ring;
  int slots = 6, maxWidth = 1920, maxHeight = 1080;
  std::atomic<bool> quitting{false};
  // The render thread makes the ring once the file says how big its picture is.
  std::mutex m;
  std::condition_variable cv;
  int ringWidth = 0, ringHeight = 0;  // asked for by the event loop
  bool updated = false;
  std::atomic<bool> loaded{false};
  // 1 once the render context exists, -1 if the GPU failed. A file loaded before it would play with
  // no video at all: mpv drops the video track when there is no render context to give it to.
  std::atomic<int> started{0};
};
static Engine E;
// Seconds the sound of a video is held (see FILE_LOADED), measured per system. ponytail: Linux has no measurement of
// its own and takes the Mac's.
#ifdef _WIN32
static const char* AUDIO_DELAY = "0.040";
#else
static const char* AUDIO_DELAY = "0.065";
#endif

static void onUpdate(void*) {
  { std::lock_guard<std::mutex> l(E.m); E.updated = true; }
  E.cv.notify_all();
}

// Fits the picture in the box keeping its shape, with even sides (4:2:0 sources), never larger than it is.
static void fit(int w, int h, int& outW, int& outH) {
  double k = std::min(1.0, std::min((double)E.maxWidth / w, (double)E.maxHeight / h));
  outW = std::max(2, (int)std::lround(w * k / 2) * 2);
  outH = std::max(2, (int)std::lround(h * k / 2) * 2);
}

static void renderLoop(GpuOptions options) {
  try {
    Gpu gpu(options);
    gpu.init();
    std::vector<mpv_render_param> params;
    gpu.renderContextParams(params);
    params.push_back({MPV_RENDER_PARAM_INVALID, nullptr});
    mpv_render_context* rctx = nullptr;
    int e = mpv_render_context_create(&rctx, E.mpv, params.data());
    if (e < 0) fail("engine-gpu", std::string("mpv_render_context_create: ") + mpv_error_string(e));
    mpv_render_context_set_update_callback(rctx, onUpdate, nullptr);
    emit("{\"ev\":\"ready\",\"gpu\":" + js(gpu.describe) + "}");
    E.started = 1;
    bool ringReady = false;
    // A GPU that is gone (a driver reset, DEVICE_REMOVED) fails every frame in silence: the picture froze
    // while the sound and the clock went on and nobody was told (2026-11-10 review, agent1-05).
    int failures = 0;
    const int maxFailures = 30;
    while (!E.quitting) {
      int w = 0, h = 0;
      {
        std::unique_lock<std::mutex> l(E.m);
        E.cv.wait_for(l, std::chrono::milliseconds(50), [&] { return E.updated || E.quitting || (E.ringWidth && !ringReady); });
        E.updated = false;
        if (!ringReady && E.ringWidth) { w = E.ringWidth; h = E.ringHeight; }
      }
      if (w) {
        std::string handles = gpu.createRing(w, h, E.slots);
        E.ring.reset(E.slots);
        ringReady = true;
        emit("{\"ev\":\"slots\",\"width\":" + std::to_string(w) + ",\"height\":" + std::to_string(h) + ",\"handles\":" + handles + "}");
      }
      if (!(mpv_render_context_update(rctx) & MPV_RENDER_UPDATE_FRAME) || !ringReady) continue;
      int slot = E.ring.acquire();
      if (slot < 0) break;
      std::vector<mpv_render_param> rp;
      bool began = gpu.beginFrame(slot, rp);
      int re = -1;
      if (began) {
        rp.push_back({MPV_RENDER_PARAM_INVALID, nullptr});
        re = mpv_render_context_render(rctx, rp.data());
        gpu.endFrame(slot);
      }
      if (!began || re < 0) {
        E.ring.release(slot);
        if (++failures >= maxFailures) fail("engine-gpu", "the GPU failed " + std::to_string(failures) + " frames in a row");
        continue;
      }
      failures = 0;
      emit("{\"ev\":\"frame\",\"slot\":" + std::to_string(slot) + "}");
      mpv_render_context_report_swap(rctx);
    }
    mpv_render_context_free(rctx);
    gpu.releaseShared();
  } catch (const Fail& f) {
    emitError(f);
    E.started = -1;
  }
}

static double prop(const char* name, double fallback = 0) {
  double v = fallback;
  return mpv_get_property(E.mpv, name, MPV_FORMAT_DOUBLE, &v) >= 0 ? v : fallback;
}
static void set(const char* name, const std::string& value) { mpv_set_property_string(E.mpv, name, value.c_str()); }

// What the status reports, as mpv announces it (observed properties): never asked for while playing. A
// synchronous `mpv_get_property` waits for the core, and on a file's first frame the core was waiting
// for us to render it — into a ring this same thread had not made yet (2026-11-10 review, agent2-05).
static struct {
  double time = 0, duration = 0;
  bool paused = false, ended = false;
  int64_t dwidth = 0, dheight = 0;
} seen;

static void emitStatus() {
  emit("{\"ev\":\"status\",\"time\":" + num(seen.time) + ",\"duration\":" + num(seen.duration) + ",\"paused\":" +
       boolean(seen.paused) + ",\"ended\":" + boolean(seen.ended) + "}");
}

// The picture's size as displayed (aspect applied) is known: the ring can be made, once.
static void askForRing() {
  if (E.ringWidth || seen.dwidth <= 0 || seen.dheight <= 0) return;
  int rw, rh;
  fit((int)seen.dwidth, (int)seen.dheight, rw, rh);
  { std::lock_guard<std::mutex> l(E.m); E.ringWidth = rw; E.ringHeight = rh; }
  E.cv.notify_all();
}

// One command line from main. Returns false on `quit`.
static bool command(const std::string& line) {
  auto word = [&](size_t& at) {
    size_t end = line.find(' ', at);
    std::string w = line.substr(at, end == std::string::npos ? std::string::npos : end - at);
    at = end == std::string::npos ? line.size() : end + 1;
    return w;
  };
  size_t at = 0;
  std::string cmd = word(at);
  if (cmd == "quit") {
    // The picture goes at once; the core keeps playing until it is torn down (~0.25 s with sound):
    // the room heard the video it had just left (2026-11-10 review, agent1-04).
    set("mute", "yes");
    return false;
  }
  if (cmd == "release") E.ring.release(atoi(word(at).c_str()));
  else if (cmd == "pause") set("pause", word(at) == "1" ? "yes" : "no");
  else if (cmd == "volume") set("volume", word(at));
  else if (cmd == "loop") set("loop-file", word(at) == "1" ? "inf" : "no");
  else if (cmd == "seek") {
    std::string to = word(at), how = word(at) == "exact" ? "absolute+exact" : "absolute+keyframes";
    const char* c[] = {"seek", to.c_str(), how.c_str(), nullptr};
    mpv_command_async(E.mpv, 0, c);
  } else if (cmd == "load") {
    while (E.started == 0 && !E.quitting) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    if (E.started < 0) return true;
    // Set before loadfile: `start` and friends apply to the next file, and the loadfile argument
    // list changed shape in mpv 0.38 (the system libmpv on Linux can be as old as 0.34).
    set("start", word(at));
    set("pause", word(at) == "1" ? "yes" : "no");
    set("volume", word(at));
    set("loop-file", word(at) == "1" ? "inf" : "no");
    set("aid", word(at) == "1" ? "auto" : "no");
    std::string path = line.substr(at);
    const char* c[] = {"loadfile", path.c_str(), nullptr};
    mpv_command_async(E.mpv, 0, c);
  } else {
    emitError({"engine-args", "unknown command " + cmd});
  }
  return true;
}

int main(int argc, char** argv) {
#ifdef _WIN32
  // Windows hands `argv` over in the ANSI code page: an NDI output named «Iglesia Ñandú» reached every
  // receiver as invalid UTF-8, and anything outside that page as «?» (2026-11-10 review, agent8-01).
  // The wide command line, as UTF-8, is what every other part of the engine expects.
  std::vector<std::string> utf8Args;
  std::vector<char*> utf8Argv;
  {
    int wargc = 0;
    if (LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc)) {
      for (int i = 0; i < wargc; i++) {
        int size = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, nullptr, 0, nullptr, nullptr);
        std::string arg(size > 0 ? size - 1 : 0, '\0');
        if (size > 1) WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, arg.data(), size, nullptr, nullptr);
        utf8Args.push_back(std::move(arg));
      }
      LocalFree(wargv);
      for (auto& arg : utf8Args) utf8Argv.push_back(arg.data());
      utf8Argv.push_back(nullptr);
      argc = wargc;
      argv = utf8Argv.data();
    }
  }
#endif
  GpuOptions options;
  std::string closeHandles, logLevel = "error", cacheDir;
#ifdef _WIN32
  std::string hwdec = "d3d11va";
  timeBeginPeriod(1);
  // Windows 11 ignores timeBeginPeriod for a process with no visible window that plays no sound, so a
  // silent video's frame waits rounded to the 15.6 ms tick: 1 frame in 12 lost at 60 fps (measured
  // 2026-10-30). Opt out of that, and of EcoQoS, which a windowless process may also get.
  PROCESS_POWER_THROTTLING_STATE throttling{PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                                            PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, 0};
  SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &throttling, sizeof throttling);
#else
  std::string hwdec = "auto";
#endif
  // The NDI output (ndi.cpp) is this same binary in another mode: it never touches mpv.
  if (argc > 2 && std::string(argv[1]) == "--ndi-send") return ndiSendMain(argc, argv);
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string k = argv[i], v = argv[i + 1];
    if (k == "--parent") options.parentPid = strtoul(v.c_str(), nullptr, 10);
    else if (k == "--fd-socket") options.fdSocket = v;
    else if (k == "--max-width") E.maxWidth = std::max(16, atoi(v.c_str()));
    else if (k == "--max-height") E.maxHeight = std::max(16, atoi(v.c_str()));
    else if (k == "--slots") E.slots = std::clamp(atoi(v.c_str()), 2, 16);
    else if (k == "--hwdec") hwdec = v;
    else if (k == "--close-in-parent") closeHandles = v;
    else if (k == "--log-level") logLevel = v;
    else if (k == "--cache-dir") cacheDir = v;
  }
#ifdef _WIN32
  std::vector<unsigned long long> handles;
  for (size_t at = 0; at < closeHandles.size();) {
    size_t end = closeHandles.find(',', at);
    handles.push_back(strtoull(closeHandles.substr(at, end - at).c_str(), nullptr, 10));
    at = end == std::string::npos ? closeHandles.size() : end + 1;
  }
  if (!handles.empty()) closeInParent(options.parentPid, handles);
#endif

#ifdef __APPLE__
  std::thread(becomeKnownToCoreAudio).detach();
#endif
  E.mpv = mpv_create();
  if (!E.mpv) { emitError({"engine-gpu", "mpv_create"}); return 1; }
  const char* opts[][2] = {{"vo", "libmpv"}, {"hwdec", hwdec.c_str()}, {"keep-open", "yes"}, {"idle", "yes"},
                           {"terminal", "no"}, {"config", "no"}, {"input-default-bindings", "no"}, {"osc", "no"},
                           {"load-scripts", "no"}, {"sub-auto", "no"}, {"audio-display", "no"},
                           // An interlaced file (a DVD, a camcorder's 1080i) is shown deinterlaced, as the
                           // conversion before 2.2.0 did with bwdif; a progressive one costs nothing. mpv
                           // 0.41 defaults to `no`: every moving edge was combed (2026-11-10 review,
                           // agent1-01). A libmpv too old for `auto` (Linux's system one) refuses it, harmless.
                           {"deinterlace", "auto"}};
  for (auto& o : opts) mpv_set_option_string(E.mpv, o[0], o[1]);
  // Compiled shaders kept between engines: libmpv with config=no has no cache dir of its own.
  if (!cacheDir.empty()) mpv_set_option_string(E.mpv, "gpu-shader-cache-dir", cacheDir.c_str());
  mpv_request_log_messages(E.mpv, logLevel.c_str());
  if (mpv_initialize(E.mpv) < 0) { emitError({"engine-gpu", "mpv_initialize"}); return 1; }
  mpv_observe_property(E.mpv, 0, "pause", MPV_FORMAT_FLAG);
  mpv_observe_property(E.mpv, 0, "eof-reached", MPV_FORMAT_FLAG);
  mpv_observe_property(E.mpv, 0, "time-pos", MPV_FORMAT_DOUBLE);
  mpv_observe_property(E.mpv, 0, "duration", MPV_FORMAT_DOUBLE);
  mpv_observe_property(E.mpv, 0, "dwidth", MPV_FORMAT_INT64);
  mpv_observe_property(E.mpv, 0, "dheight", MPV_FORMAT_INT64);

  std::thread renderer(renderLoop, options);
  std::thread input([] {
    char buf[8192];
    while (fgets(buf, sizeof buf, stdin)) {
      std::string line(buf);
      while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
      if (!command(line)) break;
    }
    // stdin closed or `quit`: main is gone or done with us.
    E.quitting = true;
    E.ring.close();
    E.cv.notify_all();
    mpv_wakeup(E.mpv);
  });

  auto lastStatus = std::chrono::steady_clock::now();
  std::string lastError;
  while (!E.quitting && E.started >= 0) {
    mpv_event* ev = mpv_wait_event(E.mpv, 0.05);
    bool changed = false;
    switch (ev->event_id) {
      case MPV_EVENT_FILE_LOADED: {
        // The picture's size is only known at the first VIDEO_RECONFIG; this is the container's.
        int64_t w = 0, h = 0, video = 0, audio = 0;
        mpv_get_property(E.mpv, "width", MPV_FORMAT_INT64, &w);
        mpv_get_property(E.mpv, "height", MPV_FORMAT_INT64, &h);
        mpv_get_property(E.mpv, "current-tracks/video/id", MPV_FORMAT_INT64, &video);
        mpv_get_property(E.mpv, "current-tracks/audio/id", MPV_FORMAT_INT64, &audio);
        emit("{\"ev\":\"loaded\",\"duration\":" + num(prop("duration")) + ",\"width\":" + std::to_string(w) + ",\"height\":" +
             std::to_string(h) + ",\"hasVideo\":" + boolean(video > 0) + ",\"hasAudio\":" + boolean(audio > 0) + "}");
        // The ring from the container's picture now, as it will be displayed (pixel aspect, rotation).
        // Waiting for `dwidth` cost 200 ms on every file: mpv only publishes it after the first frame is
        // rendered, and its VO waits that long for a render into a ring that did not exist yet
        // (2026-11-10 review, agent2-05; mpv's own log: «mpv_render_context_render() not being called»).
        // Only when the container says its pixel aspect: an MPEG-2 (a DVD) keeps it in the stream, and
        // its 720×576 is shown 1024×576 — that one still waits for `dwidth`, slower but right.
        double par = 0;
        if (video > 0 && w > 0 && h > 0 &&
            mpv_get_property(E.mpv, "current-tracks/video/demux-par", MPV_FORMAT_DOUBLE, &par) >= 0 && par > 0) {
          int64_t rotation = 0;
          mpv_get_property(E.mpv, "current-tracks/video/demux-rotation", MPV_FORMAT_INT64, &rotation);
          int64_t dw = std::llround(w * (par > 1 ? par : 1.0)), dh = std::llround(h / (par < 1 ? par : 1.0));
          if (rotation % 180 == 90) std::swap(dw, dh);
          seen.dwidth = dw;
          seen.dheight = dh;
          askForRing();
        }
        // mpv puts the sound out as it renders the frame, but the frame still crosses main and the page before
        // it shows: measured on a Mac's screen and speakers (ScreenCaptureKit, 2026-11-10), the sound of an
        // engine video came 61 ms before its picture, Chromium's 11 ms (agent2-02). Held 50 ms it came −12 ms in
        // the room, but over NDI, whose window paints at its own 30 Hz, −3…−47 ms by each start's phase; held
        // 65 ms: +2 ms in the room, +3…+29 ms over NDI (EBU R37: −40…+60). On Windows the same 65 ms gave
        // +43…+60 ms over NDI, later than Chromium's +5…+39 there; 50 ms +7…+50; 40 ms +14…+31. Only a file
        // with a picture: a song alone has nothing to meet.
        if (video > 0) set("audio-delay", AUDIO_DELAY);
        E.loaded = true;
        changed = true;
        break;
      }
      case MPV_EVENT_VIDEO_RECONFIG:
        // The ring is made once, for the picture as displayed (aspect applied): `dwidth`/`dheight` below.
        askForRing();
        break;
      case MPV_EVENT_END_FILE: {
        auto* ef = (mpv_event_end_file*)ev->data;
        if (ef->reason == MPV_END_FILE_REASON_ERROR)
          emitError({"engine-open", std::string(mpv_error_string(ef->error)) + (lastError.empty() ? "" : ": " + lastError)});
        break;
      }
      case MPV_EVENT_LOG_MESSAGE: {
        auto* lm = (mpv_event_log_message*)ev->data;
        std::string text = std::string("[") + lm->prefix + "] " + lm->text;
        while (!text.empty() && text.back() == '\n') text.pop_back();
        fprintf(stderr, "%s\n", text.c_str());
        if (lm->log_level <= MPV_LOG_LEVEL_ERROR) lastError = text;
        break;
      }
      case MPV_EVENT_PROPERTY_CHANGE: {
        auto* pc = (mpv_event_property*)ev->data;
        std::string name = pc->name;
        bool has = pc->data != nullptr;
        if (name == "time-pos") seen.time = has && pc->format == MPV_FORMAT_DOUBLE ? *(double*)pc->data : 0;
        else if (name == "duration") seen.duration = has && pc->format == MPV_FORMAT_DOUBLE ? *(double*)pc->data : 0;
        else if (name == "dwidth" || name == "dheight") {
          (name == "dwidth" ? seen.dwidth : seen.dheight) = has && pc->format == MPV_FORMAT_INT64 ? *(int64_t*)pc->data : 0;
          askForRing();
        } else {
          bool on = has && pc->format == MPV_FORMAT_FLAG && *(int*)pc->data;
          (name == "pause" ? seen.paused : seen.ended) = on;
          changed = true;  // the position moves every frame: only these are news on their own
        }
        break;
      }
      case MPV_EVENT_PLAYBACK_RESTART:  // a seek landed: the scrubber is waiting for this position
        changed = true;
        break;
      default:
        break;
    }
    auto now = std::chrono::steady_clock::now();
    if (changed || now - lastStatus >= std::chrono::milliseconds(250)) {
      lastStatus = now;
      if (E.loaded) emitStatus();
    }
  }
  E.quitting = true;
  E.ring.close();
  E.cv.notify_all();
  renderer.join();
  mpv_terminate_destroy(E.mpv);
  // The input thread may be blocked reading stdin; the process is ending, which unblocks it.
  input.detach();
  return E.started < 0 ? 1 : 0;
}
