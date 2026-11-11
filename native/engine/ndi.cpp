// The engine's NDI® output mode: Electron main draws the projection in an offscreen window and hands each
// painted frame over as a shared GPU texture; this process reads it into memory and sends every one, in order,
// over NDI at a steady rate, so a crash in the NDI SDK takes down only the NDI output. The NDI runtime is
// the user's own (ndi.video), loaded at run time; headers: NDI SDK 6.3.2.0 (MIT), native/ndi/include/.
//
//   media-engine --ndi-send <name> --width <w> --height <h> --fps <n> [--ndi-lib <path>]
//                [--audio 1 --audio-delay <ms>]   the app's own sound too (ndi-audio.h), held <ms> to meet its picture
//     Windows  --parent <pid>          stdin: «frame <NT handle value in main>» per frame
//     macOS    --mach-service <name>   the IOSurface's mach port, one mach message per frame
//     Linux    --fd-socket <path>      a SOCK_SEQPACKET socket: «w h modifier planes stride offset…» + the dmabuf fds
//   stdin also takes «quit» (or EOF). Engine → main (stdout), JSON:
//     {"ev":"ready","runtime":…}                 listening for frames
//     {"ev":"done"}                              read the frame main is holding: it can release it now
//     {"ev":"status","receivers":…}              on every change; with none, a new frame is encoded once, not repeated
//     {"ev":"audio","state":"on"|"off","detail":…,"level":…}  the sound: on (and its loudest sample in the last second,
//                                                dBFS, once a second), or off and why
//     {"ev":"error","code":…,"detail":…}         ndi-runtime-missing (exit 3) · ndi-send (exit 4) · ndi-gpu
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>  // NULL, which the SDK headers use without including it
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <Processing.NDI.Lib.h>

#include "gpu.h"
#include "ndi-audio.h"

#ifndef _WIN32
#include <dlfcn.h>
#endif

void emit(const std::string& json);
std::string js(const std::string& s);

struct Options {
  std::string name, lib, macService, fdSocket;
  int width = 1920, height = 1080, fps = 30;
  unsigned long parentPid = 0;
  bool audio = false;
  int audioDelayMs = 0;
};

static std::atomic<bool> quitting{false};
static void emitError(const std::string& code, const std::string& detail) {
  emit("{\"ev\":\"error\",\"code\":" + js(code) + ",\"detail\":" + js(detail) + "}");
}

// One painted frame, read out of its texture. `next` blocks until a frame comes: 1 = read into `dst`
// (tightly packed BGRA, w*h*4 bytes at most `capacity`), 0 = that one could not be read, -1 = no more.
struct Frames {
  bool open(const Options& o);  // throws Fail
  int next(uint8_t* dst, size_t capacity, int& w, int& h);
  struct State;
  State* s = nullptr;
};

#ifdef _WIN32
// ---------------------------------------------------------------------------------------------- Windows
// Chromium's texture lives on the GPU Electron's GPU process picked: its NT handle is duplicated out of main,
// opened on our device (the adapter that opens it, if there are two), copied to a staging texture and mapped.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>

struct Frames::State {
  HANDLE parent = nullptr;
  ID3D11Device1* dev = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  ID3D11Texture2D* staging = nullptr;
  int sw = 0, sh = 0;  // the staging texture's size
  bool reported = false;
};

static ID3D11Device1* createDevice(IDXGIAdapter* adapter, ID3D11DeviceContext** ctx) {
  ID3D11Device* d = nullptr;
  ID3D11Device1* d1 = nullptr;
  if (FAILED(D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                               D3D11_SDK_VERSION, &d, nullptr, ctx)))
    return nullptr;
  d->QueryInterface(__uuidof(ID3D11Device1), (void**)&d1);
  d->Release();
  return d1;
}

bool Frames::open(const Options& o) {
  s = new State;
  if (!(s->parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, (DWORD)o.parentPid)))
    fail("ndi-gpu", "OpenProcess(parent) " + std::to_string(GetLastError()));
  if (!(s->dev = createDevice(nullptr, &s->ctx))) fail("ndi-gpu", "D3D11CreateDevice");
  return true;
}

// Another adapter, for a texture the current device can't open (a laptop with two GPUs).
static bool openOnAnyAdapter(Frames::State* s, HANDLE handle, ID3D11Texture2D** tex) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory))) return false;
  IDXGIAdapter1* adapter = nullptr;
  bool opened = false;
  for (UINT i = 0; !opened && factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
    ID3D11DeviceContext* ctx = nullptr;
    ID3D11Device1* dev = createDevice(adapter, &ctx);
    adapter->Release();
    if (dev && SUCCEEDED(dev->OpenSharedResource1(handle, __uuidof(ID3D11Texture2D), (void**)tex))) {
      if (s->staging) s->staging->Release();
      s->staging = nullptr;
      s->ctx->Release();
      s->dev->Release();
      s->dev = dev;
      s->ctx = ctx;
      opened = true;
    } else {
      if (ctx) ctx->Release();
      if (dev) dev->Release();
    }
  }
  factory->Release();
  return opened;
}

int Frames::next(uint8_t* dst, size_t capacity, int& w, int& h) {
  char line[128];
  if (!fgets(line, sizeof line, stdin) || !strncmp(line, "quit", 4)) return -1;
  if (strncmp(line, "frame ", 6)) return 0;
  HANDLE local = nullptr;
  ID3D11Texture2D* tex = nullptr;
  int r = 0;
  if (!DuplicateHandle(s->parent, (HANDLE)(uintptr_t)strtoull(line + 6, nullptr, 10), GetCurrentProcess(), &local, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    if (!s->reported) emitError("ndi-gpu", "DuplicateHandle " + std::to_string(GetLastError()));
    s->reported = true;
    return 0;
  }
  if (FAILED(s->dev->OpenSharedResource1(local, __uuidof(ID3D11Texture2D), (void**)&tex)) && !openOnAnyAdapter(s, local, &tex)) {
    if (!s->reported) emitError("ndi-gpu", "OpenSharedResource1 found no adapter for the texture");
    s->reported = true;
    CloseHandle(local);
    return 0;
  }
  D3D11_TEXTURE2D_DESC d;
  tex->GetDesc(&d);
  w = (int)d.Width;
  h = (int)d.Height;
  if ((size_t)w * h * 4 <= capacity) {
    if (!s->staging || s->sw != w || s->sh != h) {
      if (s->staging) s->staging->Release();
      s->staging = nullptr;
      D3D11_TEXTURE2D_DESC sd{};
      sd.Width = d.Width;
      sd.Height = d.Height;
      sd.MipLevels = sd.ArraySize = 1;
      sd.Format = d.Format;  // BGRA: what Electron gives for `argb`
      sd.SampleDesc.Count = 1;
      sd.Usage = D3D11_USAGE_STAGING;
      sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      if (SUCCEEDED(s->dev->CreateTexture2D(&sd, nullptr, &s->staging))) { s->sw = w; s->sh = h; }
    }
    D3D11_MAPPED_SUBRESOURCE map;
    if (s->staging) {
      s->ctx->CopyResource(s->staging, tex);
      if (SUCCEEDED(s->ctx->Map(s->staging, 0, D3D11_MAP_READ, 0, &map))) {
        for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * w * 4, (uint8_t*)map.pData + (size_t)y * map.RowPitch, (size_t)w * 4);
        s->ctx->Unmap(s->staging, 0);
        r = 1;
      }
    }
  }
  tex->Release();
  CloseHandle(local);
  return r;
}

#elif defined(__APPLE__)
// ------------------------------------------------------------------------------------------------ macOS
// Electron's IOSurface is local to main, so main sends its mach port (IOSurfaceCreateMachPort) to the name
// this process checked in with launchd; on Apple Silicon the lock is a cache flush, not a copy back.
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

namespace {
struct SurfaceMessage {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  mach_msg_trailer_t trailer;  // room for the receive side's
};
}  // namespace

struct Frames::State {
  mach_port_t port = MACH_PORT_NULL;
};

bool Frames::open(const Options& o) {
  s = new State;
  kern_return_t kr = bootstrap_check_in(bootstrap_port, o.macService.c_str(), &s->port);
  if (kr != KERN_SUCCESS) fail("ndi-gpu", "bootstrap_check_in(" + o.macService + "): " + bootstrap_strerror(kr));
  return true;
}

int Frames::next(uint8_t* dst, size_t capacity, int& w, int& h) {
  SurfaceMessage m{};
  if (mach_msg(&m.header, MACH_RCV_MSG, 0, sizeof m, s->port, MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL) != KERN_SUCCESS) return -1;
  if (!(m.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) || m.body.msgh_descriptor_count != 1) {
    mach_msg_destroy(&m.header);
    return 0;
  }
  IOSurfaceRef surface = IOSurfaceLookupFromMachPort(m.surface.name);
  mach_port_deallocate(mach_task_self(), m.surface.name);
  if (!surface) return 0;
  w = (int)IOSurfaceGetWidth(surface);
  h = (int)IOSurfaceGetHeight(surface);
  int r = 0;
  if ((size_t)w * h * 4 <= capacity && IOSurfaceGetBytesPerElement(surface) == 4 &&
      IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) == KERN_SUCCESS) {
    auto* src = (const uint8_t*)IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * w * 4, src + y * stride, (size_t)w * 4);
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
    r = 1;
  }
  CFRelease(surface);
  return r;
}

#else
// ------------------------------------------------------------------------------------------------ Linux
// The texture is a linear dmabuf (Electron's on Intel's Mesa, modifier 0), read straight through mmap between
// the kernel's DMA_BUF_IOCTL_SYNC fences. Imported as an EGLImage instead, glGetTexImage read zeros and a
// framebuffer on it was incomplete (measured 2026-11-09). A tiled buffer would need the GPU to untile it:
// reported, never sent as a black picture.
#include <drm_fourcc.h>
#include <linux/dma-buf.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>

struct Frames::State {
  int server = -1, conn = -1;
  bool reported = false;
};

bool Frames::open(const Options& o) {
  s = new State;
  s->server = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, o.fdSocket.c_str(), sizeof a.sun_path - 1);
  unlink(a.sun_path);
  if (s->server < 0 || bind(s->server, (sockaddr*)&a, sizeof a) < 0 || listen(s->server, 1) < 0)
    fail("ndi-gpu", "listen " + o.fdSocket + ": " + strerror(errno));
  return true;
}

static int readLinear(int fd, int offset, int stride, int w, int h, uint8_t* dst) {
  size_t size = (size_t)offset + (size_t)stride * h;
  void* m = mmap(nullptr, size, PROT_READ, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) return 0;
  dma_buf_sync sync{DMA_BUF_SYNC_START | DMA_BUF_SYNC_READ};
  ioctl(fd, DMA_BUF_IOCTL_SYNC, &sync);
  for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * w * 4, (uint8_t*)m + offset + (size_t)y * stride, (size_t)w * 4);
  sync.flags = DMA_BUF_SYNC_END | DMA_BUF_SYNC_READ;
  ioctl(fd, DMA_BUF_IOCTL_SYNC, &sync);
  munmap(m, size);
  return 1;
}

int Frames::next(uint8_t* dst, size_t capacity, int& w, int& h) {
  if (s->conn < 0 && (s->conn = accept4(s->server, nullptr, nullptr, SOCK_CLOEXEC)) < 0) return -1;
  char text[256] = {0};
  iovec io{text, sizeof text - 1};
  std::vector<char> control(CMSG_SPACE(sizeof(int) * 4));
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = control.data();
  msg.msg_controllen = control.size();
  if (recvmsg(s->conn, &msg, MSG_CMSG_CLOEXEC) <= 0) return -1;
  std::vector<int> fds;
  for (cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS)
      for (size_t i = 0; i < (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); i++) {
        int fd;
        memcpy(&fd, CMSG_DATA(c) + i * sizeof(int), sizeof fd);
        fds.push_back(fd);
      }
  unsigned long long modifier = DRM_FORMAT_MOD_INVALID;
  int planes = 0, stride = 0, offset = 0;
  sscanf(text, "%d %d %llu %d %d %d", &w, &h, &modifier, &planes, &stride, &offset);
  int r = 0;
  if (modifier == DRM_FORMAT_MOD_LINEAR && planes == 1 && fds.size() == 1 && stride >= w * 4 && (size_t)w * h * 4 <= capacity)
    r = readLinear(fds[0], offset, stride, w, h, dst);
  if (!r && !s->reported) {
    emitError("ndi-gpu", std::string("dmabuf not read: ") + text);
    s->reported = true;
  }
  for (int fd : fds) close(fd);
  return r;
}
#endif

namespace {

#ifdef _WIN32
void* openLib(const std::string& p) { return (void*)LoadLibraryA(p.c_str()); }
void* sym(void* h, const char* s) { return (void*)GetProcAddress((HMODULE)h, s); }
std::string exeDir() {
  char b[MAX_PATH];
  std::string p(b, GetModuleFileNameA(nullptr, b, MAX_PATH));
  return p.substr(0, p.find_last_of('\\') + 1);
}
#else
void* openLib(const std::string& p) { return dlopen(p.c_str(), RTLD_NOW | RTLD_LOCAL); }
void* sym(void* h, const char* s) { return dlsym(h, s); }
std::string exeDir() { return ""; }  // set from argv[0] below
#endif

// The user's runtime, in the order NDI documents: an explicit path, one next to the engine (unused today:
// it is never bundled, see the plan), the folder the runtime installer exports, then the standard places.
const NDIlib_v6* loadRuntime(const std::string& forced, const std::string& dir) {
  std::vector<std::string> tries;
  if (!forced.empty()) tries.push_back(forced);
  tries.push_back(dir + NDILIB_LIBRARY_NAME);
#ifdef _WIN32
  for (const char* var : {"NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"})
    if (const char* d = getenv(var)) tries.push_back(std::string(d) + "\\" + NDILIB_LIBRARY_NAME);
#elif defined(__APPLE__)
  if (const char* d = getenv("NDI_RUNTIME_DIR_V6")) tries.push_back(std::string(d) + "/" + NDILIB_LIBRARY_NAME);
  tries.push_back("/usr/local/lib/libndi.dylib");
  tries.push_back("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib");
#else
  if (const char* d = getenv("NDI_RUNTIME_DIR_V6")) tries.push_back(std::string(d) + "/" + NDILIB_LIBRARY_NAME);
  tries.push_back("libndi.so.6");
  tries.push_back("libndi.so.5");
#endif
  for (auto& p : tries) {
    void* h = openLib(p);
    if (!h) continue;
    // Every version's table is the same struct (Processing.NDI.DynamicLoad.h), and what this mode calls is
    // in all of them: an NDI 5 runtime is fine too.
    for (const char* entry : {"NDIlib_v6_load", "NDIlib_v5_load"})
      if (auto load = (const NDIlib_v6* (*)())sym(h, entry))
        if (const NDIlib_v6* ndi = load()) {
          fprintf(stderr, "[ndi] runtime %s\n", p.c_str());
          return ndi;
        }
  }
  return nullptr;
}

// The frames read and not sent yet, oldest first. The page paints at the output's rate on Chromium's clock and the
// SDK sends at it on its own: two frames often land in one send period, and «only the latest» lost the first of
// them — 0–27 % of a 30 fps video, by the phase between the two clocks (measured 2026-11-09). Queued, it waits a
// period instead. Past MAX_WAITING the oldest goes, so a sender that falls behind costs frames, never latency.
constexpr int MAX_WAITING = 3;
struct Queue {
  std::mutex m;
  static constexpr int N = MAX_WAITING + 2;  // + the one being read into, + the last sent (repeated while still)
  std::vector<uint8_t> buf[N];
  int w[N] = {}, h[N] = {};
  int64_t tc[N] = {};  // when it was painted: the picture's moment, on the clock the sound is stamped with
  std::deque<int> waiting;
  int writing = 0, last = -1;
  // Called with `m` held, `writing` just filled: queue it and pick a buffer nobody holds.
  void push() {
    waiting.push_back(writing);
    if ((int)waiting.size() > MAX_WAITING) waiting.pop_front();
    for (int i = 0; i < N; i++)
      if (i != last && std::find(waiting.begin(), waiting.end(), i) == waiting.end()) { writing = i; return; }
  }
};

// The app's sound on its way out: stamped with when the room heard it, and held back `delay` so it leaves with the
// picture of that same moment, which waits in the queue above (painted → read → sent at the output's rate). Planar
// float, NDI's own layout. While watched, a gap the capture left (Windows' loopback says nothing while the app is
// silent) is filled with silence by the clock, so receivers never see the sound stop and start again.
struct AudioOut : AudioSink {
  struct Chunk {
    int64_t tc;
    int frames, channels, rate;
    std::vector<float> planar;
  };
  std::mutex m;
  std::deque<Chunk> q;
  std::atomic<int64_t> delay{0};
  std::atomic<bool> watched{false};
  int64_t expected = 0;  // the timecode right after the last sample queued
  int rate = 48000, channels = 2;
  float peak = 0;

  void queue(const float* in, int frames, int ch, int r, int64_t tc) {  // `m` held
    Chunk c{tc, frames, ch, r, std::vector<float>((size_t)frames * ch, 0.f)};
    if (in)
      for (int i = 0; i < frames; i++)
        for (int k = 0; k < ch; k++) {
          float v = in[(size_t)i * ch + k];
          c.planar[(size_t)k * frames + i] = v;
          peak = std::max(peak, std::fabs(v));
        }
    q.push_back(std::move(c));
    // Two seconds at most: a sender that stalls costs sound, never memory or latency.
    while (q.size() > 400) q.pop_front();
    expected = tc + (int64_t)frames * 10000000 / r;
    rate = r;
    channels = ch;
  }
  void push(const float* in, int frames, int ch, int r, int64_t tc) override {
    if (frames <= 0 || ch <= 0 || r <= 0) return;
    std::lock_guard<std::mutex> l(m);
    // Captures overlap by a few samples at their joints (two clocks): what the timeline already has goes.
    if (expected && tc < expected - 20000) {
      int skip = (int)((expected - tc) * r / 10000000);
      if (skip >= frames) return;
      in += (size_t)skip * ch;
      frames -= skip;
      tc = expected;
    }
    fillUntil(tc);
    queue(in, frames, ch, r, tc);
  }
  void fillUntil(int64_t until) {  // `m` held
    if (!watched) return;
    while (expected && until - expected > 100000) queue(nullptr, rate / 100, channels, rate, expected);  // 10 ms each
  }
  // Every few milliseconds: what is due goes out — or, unwatched, away.
  void pump(const NDIlib_v6* ndi, NDIlib_send_instance_t sender) {
    std::lock_guard<std::mutex> l(m);
    int64_t now = nowTc(), d = delay;
    if (watched) fillUntil(now - d - 500000);  // 50 ms of grace before inventing silence
    while (!q.empty() && q.front().tc + d <= now) {
      Chunk& c = q.front();
      if (watched) {
        NDIlib_audio_frame_v3_t f;
        f.sample_rate = c.rate;
        f.no_channels = c.channels;
        f.no_samples = c.frames;
        // Shifted with it too: a receiver that aligns by timecode (OBS by default) follows the same setting.
        f.timecode = c.tc + d;
        f.FourCC = NDIlib_FourCC_audio_type_FLTP;
        f.p_data = (uint8_t*)c.planar.data();
        f.channel_stride_in_bytes = c.frames * (int)sizeof(float);
        ndi->send_send_audio_v3(sender, &f);
      }
      q.pop_front();
    }
    if (!watched) expected = 0;
  }
  float takePeak() {
    std::lock_guard<std::mutex> l(m);
    float p = peak;
    peak = 0;
    return p;
  }
};

}  // namespace

int ndiSendMain(int argc, char** argv) {
  Options o;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string k = argv[i], v = argv[i + 1];
    if (k == "--ndi-send") o.name = v;
    else if (k == "--ndi-lib") o.lib = v;
    else if (k == "--width") o.width = atoi(v.c_str());
    else if (k == "--height") o.height = atoi(v.c_str());
    else if (k == "--fps") o.fps = atoi(v.c_str());
    else if (k == "--parent") o.parentPid = strtoul(v.c_str(), nullptr, 10);
    else if (k == "--mach-service") o.macService = v;
    else if (k == "--fd-socket") o.fdSocket = v;
    else if (k == "--audio") o.audio = v == "1";
    else if (k == "--audio-delay") o.audioDelayMs = std::clamp(atoi(v.c_str()), -500, 1000);
  }
  if (o.name.empty() || o.width < 16 || o.height < 16 || o.width > 3840 || o.height > 2160 || o.fps < 1 || o.fps > 60) {
    emitError("ndi-send", "bad arguments");
    return 2;
  }
  std::string dir = exeDir();
#ifndef _WIN32
  std::string self = argv[0];
  dir = self.substr(0, self.find_last_of('/') + 1);
#endif
  const NDIlib_v6* ndi = loadRuntime(o.lib, dir);
  if (!ndi) {
    emitError("ndi-runtime-missing", NDILIB_REDIST_URL);
    return 3;
  }
  if (!ndi->initialize()) {
    emitError("ndi-send", "NDIlib_initialize: this CPU is not supported");
    return 4;
  }
  // Static: the reader thread is detached at the end and may still be blocked on them as the process exits.
  static Frames frames;
  try {
    frames.open(o);
  } catch (const Fail& f) {
    emitError(f.code, f.detail);
    return 4;
  }
  NDIlib_send_create_t sc;
  sc.p_ndi_name = o.name.c_str();
  sc.clock_video = true;  // send_send_video_v2 paces itself to the frame rate
  sc.clock_audio = false;
  NDIlib_send_instance_t sender = ndi->send_create(&sc);
  if (!sender) {
    emitError("ndi-send", "NDIlib_send_create");
    return 4;
  }
  emit("{\"ev\":\"ready\",\"runtime\":" + js(ndi->version()) + "}");

  static AudioOut audio;
  audio.delay = (int64_t)o.audioDelayMs * 10000;
  std::thread audioThread;
  if (o.audio) {
    std::string why;
#ifdef _WIN32
    unsigned long app = o.parentPid;
#else
    unsigned long app = (unsigned long)getppid();
#endif
    if (startAppAudio(app, &audio, why)) {
      emit("{\"ev\":\"audio\",\"state\":\"on\"}");
      audioThread = std::thread([&] {
        auto lastLevel = std::chrono::steady_clock::now();
        while (!quitting) {
          audio.pump(ndi, sender);
          auto now = std::chrono::steady_clock::now();
          if (now - lastLevel >= std::chrono::seconds(1)) {
            lastLevel = now;
            // Watched or not: Settings shows it, and it is how a test hears the app's sound.
            float peak = audio.takePeak();
            char db[32];
            snprintf(db, sizeof db, "%.1f", peak > 0 ? 20 * std::log10(peak) : -120.0);
            emit(std::string("{\"ev\":\"audio\",\"state\":\"on\",\"level\":") + db + "}");
          }
          std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
      });
    } else {
      emit("{\"ev\":\"audio\",\"state\":\"off\",\"detail\":" + js(why) + "}");
    }
  }

  const size_t capacity = (size_t)o.width * o.height * 4;
  static Queue q;
  for (auto& b : q.buf) b.resize(capacity);
  std::thread reader([&] {
    for (;;) {
      int w = 0, h = 0;
      // `writing` is the reader's own: the sender only takes from `waiting`, and `push` never hands out `last`.
      int r = frames.next(q.buf[q.writing].data(), capacity, w, h);
      if (r < 0) break;
      emit("{\"ev\":\"done\"}");
      if (r == 0) continue;
      std::lock_guard<std::mutex> l(q.m);
      q.w[q.writing] = w;
      q.h[q.writing] = h;
      q.tc[q.writing] = nowTc();
      q.push();
    }
    quitting = true;
  });
#ifndef _WIN32
  // Windows reads its frames from stdin, «quit» included; here stdin only says when to stop.
  std::thread input([] {
    char line[64];
    while (fgets(line, sizeof line, stdin) && strncmp(line, "quit", 4)) {}
    quitting = true;
  });
  input.detach();
#endif

  NDIlib_video_frame_v2_t f;
  f.FourCC = NDIlib_FourCC_video_type_BGRX;  // opaque: no alpha plane to encode or send
  f.frame_rate_N = o.fps;
  f.frame_rate_D = 1;
  int receivers = -1;
  while (!quitting) {
    int now = ndi->send_get_no_connections(sender, receivers > 0 ? 0 : 100);
    if (now != receivers) {
      receivers = now;
      audio.watched = now > 0;
      emit("{\"ev\":\"status\",\"receivers\":" + std::to_string(now) + "}");
    }
    bool fresh = false;
    int send;
    {
      std::lock_guard<std::mutex> l(q.m);
      // Unwatched, only the newest matters: it is what the SDK hands the next receiver on connecting.
      while (receivers == 0 && q.waiting.size() > 1) q.waiting.pop_front();
      if (!q.waiting.empty()) {
        q.last = q.waiting.front();
        q.waiting.pop_front();
        fresh = true;
      }
      send = q.last;
    }
    // Watched: the oldest waiting frame at the steady rate receivers expect, the last one again when the page
    // is still. Unwatched: each new frame once (main sends one every half second at most) — encoding at the
    // full rate for nobody would cost a third of a core.
    if (send < 0 || (receivers == 0 && !fresh)) {
      if (receivers > 0) std::this_thread::sleep_for(std::chrono::milliseconds(5));
      continue;
    }
    f.xres = q.w[send];
    f.yres = q.h[send];
    f.line_stride_in_bytes = f.xres * 4;
    f.p_data = q.buf[send].data();
    // When it was painted, not when it leaves: the sound is stamped the same way, so a receiver that aligns by
    // timecode lines them up whatever the queue held. A still frame sent again is stamped now.
    f.timecode = fresh ? q.tc[send] : nowTc();
    ndi->send_send_video_v2(sender, &f);
  }
  if (audioThread.joinable()) audioThread.join();
  if (o.audio) stopAppAudio();
  ndi->send_destroy(sender);
  ndi->destroy();
  // The reader may be blocked on its pipe, port or socket; the process is ending, which unblocks it.
  reader.detach();
  return 0;
}
