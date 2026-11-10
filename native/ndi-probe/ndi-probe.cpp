// A test receiver for Lumina Live's NDI® output (tests/e2e/ndi-receiver.spec.ts): what a program like OBS gets,
// measured on the received frames themselves — never «frames received per second», which a sender repeating its
// last frame keeps at 30 however broken the picture is (2.7.0 lost 0–27 % of a video that way). The NDI runtime is
// the user's own, loaded at run time, as the app does. Build: native/build.sh ndi-probe <target>.
//
//   ndi-probe find <name> <seconds>                 {"name":…,"url":…} of the first source whose name contains <name>
//   ndi-probe count <source> <url> <seconds>        video frames carrying their number as a barcode (24 blocks of 64 px
//                                                   on the top row at 1920, white = 1, then a white and a black marker):
//                                                   {"received","fresh","skipped","repeats","nobar"}, after the first
//                                                   second (the SDK hands a new receiver the frame it last sent)
//   ndi-probe avsync <source> <url> <seconds>       a file flashing white and beeping together: sound minus picture per
//                                                   pair, by timecode, in ms — {"pairs","median","p10","p90","audioFrames"}
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>  // NULL, which the SDK headers use without including it
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <Processing.NDI.Lib.h>

#ifdef _WIN32
#include <windows.h>
static void* openLib(const std::string& p) { return (void*)LoadLibraryA(p.c_str()); }
static void* sym(void* h, const char* s) { return (void*)GetProcAddress((HMODULE)h, s); }
#else
#include <dlfcn.h>
static void* openLib(const std::string& p) { return dlopen(p.c_str(), RTLD_LOCAL | RTLD_NOW); }
static void* sym(void* h, const char* s) { return dlsym(h, s); }
#endif

using Clock = std::chrono::steady_clock;
static double since(Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); }

static const NDIlib_v6* load() {
  std::vector<std::string> tries;
#ifdef _WIN32
  for (const char* var : {"NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"})
    if (const char* d = getenv(var)) tries.push_back(std::string(d) + "\\" NDILIB_LIBRARY_NAME);
#elif defined(__APPLE__)
  if (const char* d = getenv("NDI_RUNTIME_DIR_V6")) tries.push_back(std::string(d) + "/" NDILIB_LIBRARY_NAME);
  tries.push_back("/usr/local/lib/libndi.dylib");
  tries.push_back("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib");
#else
  if (const char* d = getenv("NDI_RUNTIME_DIR_V6")) tries.push_back(std::string(d) + "/" NDILIB_LIBRARY_NAME);
  tries.push_back("libndi.so.6");
  tries.push_back("libndi.so.5");
#endif
  if (const char* forced = getenv("LUMINA_NDI_LIB")) tries.insert(tries.begin(), forced);
  for (auto& p : tries)
    if (void* h = openLib(p))
      for (const char* entry : {"NDIlib_v6_load", "NDIlib_v5_load"})
        if (auto f = (const NDIlib_v6* (*)())sym(h, entry))
          if (const NDIlib_v6* ndi = f()) return ndi;
  return nullptr;
}

static std::string js(const char* s) {
  std::string o = "\"";
  for (const char* c = s; *c; c++) {
    if (*c == '"' || *c == '\\') o += '\\';
    o += *c;
  }
  return o + "\"";
}

static int find(const NDIlib_v6* ndi, const char* name, int seconds) {
  NDIlib_find_create_t fc;
  auto f = ndi->find_create_v2(&fc);
  auto start = Clock::now();
  while (f && since(start) < seconds) {
    ndi->find_wait_for_sources(f, 500);
    uint32_t n = 0;
    auto list = ndi->find_get_current_sources(f, &n);
    for (uint32_t i = 0; i < n; i++)
      if (strstr(list[i].p_ndi_name, name)) {
        printf("{\"name\":%s,\"url\":%s}\n", js(list[i].p_ndi_name).c_str(), js(list[i].p_url_address ? list[i].p_url_address : "").c_str());
        ndi->find_destroy(f);
        return 0;
      }
  }
  if (f) ndi->find_destroy(f);
  printf("{\"name\":null}\n");
  return 1;
}

static NDIlib_recv_instance_t receive(const NDIlib_v6* ndi, const char* source, const char* url) {
  NDIlib_recv_create_v3_t rc;
  rc.source_to_connect_to.p_ndi_name = source;
  rc.source_to_connect_to.p_url_address = *url ? url : nullptr;
  rc.color_format = NDIlib_recv_color_format_UYVY_BGRA;
  rc.bandwidth = NDIlib_recv_bandwidth_highest;
  return ndi->recv_create_v3(&rc);
}

static int luma(const NDIlib_video_frame_v2_t& v, int x, int y) {
  const uint8_t* row = v.p_data + (size_t)y * v.line_stride_in_bytes;
  if (v.FourCC == NDIlib_FourCC_video_type_UYVY) return row[(x / 2) * 4 + 1];
  const uint8_t* p = row + (size_t)x * 4;
  return (p[0] + p[1] + p[2]) / 3;
}

static long barcode(const NDIlib_video_frame_v2_t& v) {
  auto block = [&](int k) { return luma(v, (k * 64 + 32) * v.xres / 1920, 32 * v.yres / 1080); };
  if (block(24) < 160 || block(25) > 90) return -1;
  long n = 0;
  for (int k = 0; k < 24; k++)
    if (block(k) > 128) n |= 1L << k;
  return n;
}

static int count(const NDIlib_v6* ndi, const char* source, const char* url, int seconds) {
  auto r = receive(ndi, source, url);
  if (!r) return 1;
  long last = -1, received = 0, fresh = 0, skipped = 0, repeats = 0, nobar = 0;
  auto start = Clock::now();
  while (since(start) < seconds + 1) {
    NDIlib_video_frame_v2_t v;
    if (ndi->recv_capture_v3(r, &v, nullptr, nullptr, 200) != NDIlib_frame_type_video) continue;
    long n = barcode(v);
    ndi->recv_free_video_v2(r, &v);
    if (since(start) < 1) {
      if (n >= 0) last = n;
      continue;
    }
    received++;
    if (n < 0) nobar++;
    else if (n == last) repeats++;
    else {
      if (last >= 0 && n > last) skipped += n - last - 1;
      fresh++;
      last = n;
    }
  }
  printf("{\"received\":%ld,\"fresh\":%ld,\"skipped\":%ld,\"repeats\":%ld,\"nobar\":%ld}\n", received, fresh, skipped, repeats, nobar);
  ndi->recv_destroy(r);
  return 0;
}

static int avsync(const NDIlib_v6* ndi, const char* source, const char* url, int seconds) {
  auto r = receive(ndi, source, url);
  if (!r) return 1;
  std::vector<double> flashes, beeps;
  bool bright = false;
  long quiet = 0, audioFrames = 0;
  auto start = Clock::now();
  while (since(start) < seconds) {
    NDIlib_video_frame_v2_t v;
    NDIlib_audio_frame_v3_t a;
    auto type = ndi->recv_capture_v3(r, &v, &a, nullptr, 200);
    if (type == NDIlib_frame_type_video) {
      double sum = 0;
      int n = 0;
      for (int y = v.yres / 8; y < v.yres; y += v.yres / 8)
        for (int x = 8; x < v.xres; x += v.xres / 32, n++) sum += luma(v, x, y);
      double l = n ? sum / n : 0;
      if (!bright && l > 150) flashes.push_back(v.timecode / 1e4);
      bright = l > 150 ? true : l < 100 ? false : bright;
      ndi->recv_free_video_v2(r, &v);
    } else if (type == NDIlib_frame_type_audio) {
      audioFrames++;
      const float* ch0 = (const float*)a.p_data;
      const int win = std::max(1, a.sample_rate / 1000);
      for (int i = 0; i + win <= a.no_samples; i += win) {
        double e = 0;
        for (int k = 0; k < win; k++) e += ch0[i + k] * ch0[i + k];
        double rms = std::sqrt(e / win);
        if (rms > 0.02 && quiet > a.sample_rate / 5) beeps.push_back(a.timecode / 1e4 + (double)i / a.sample_rate * 1000);
        quiet = rms < 0.005 ? quiet + win : 0;
      }
      ndi->recv_free_audio_v3(r, &a);
    }
  }
  std::vector<double> d;
  for (double t : beeps) {
    double best = 1e18;
    for (double u : flashes)
      if (std::fabs(t - u) < std::fabs(best)) best = t - u;
    if (std::fabs(best) < 500) d.push_back(best);
  }
  std::sort(d.begin(), d.end());
  if (d.empty()) printf("{\"pairs\":0,\"audioFrames\":%ld}\n", audioFrames);
  else
    printf("{\"pairs\":%zu,\"median\":%.1f,\"p10\":%.1f,\"p90\":%.1f,\"audioFrames\":%ld}\n", d.size(), d[d.size() / 2],
           d[d.size() / 10], d[d.size() * 9 / 10], audioFrames);
  ndi->recv_destroy(r);
  return 0;
}

int main(int argc, char** argv) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  const NDIlib_v6* ndi = load();
  if (!ndi || !ndi->initialize()) {
    printf("{\"error\":\"no NDI runtime\"}\n");
    return 3;
  }
  std::string mode = argc > 1 ? argv[1] : "";
  int rc = 2;
  if (mode == "find" && argc > 3) rc = find(ndi, argv[2], atoi(argv[3]));
  else if (mode == "count" && argc > 4) rc = count(ndi, argv[2], argv[3], atoi(argv[4]));
  else if (mode == "avsync" && argc > 4) rc = avsync(ndi, argv[2], argv[3], atoi(argv[4]));
  else printf("{\"error\":\"usage\"}\n");
  ndi->destroy();
  return rc;
}
