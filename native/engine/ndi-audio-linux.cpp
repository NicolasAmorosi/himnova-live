// Linux: the default output's monitor through libpulse-simple, loaded at run time (PulseAudio, and PipeWire through
// pipewire-pulse): the whole computer's sound, not only the app's — a first version (2026-11-10). Capturing only
// the app's streams would mean linking PipeWire nodes per application (obs-pipewire-audio-capture is the reference).
#include "ndi-audio.h"

#include <dlfcn.h>
#include <time.h>

#include <atomic>
#include <thread>
#include <vector>

// libpulse-simple's few declarations, so the build needs no libpulse-dev.
struct pa_simple;
struct pa_sample_spec {
  int format;  // PA_SAMPLE_FLOAT32LE = 5
  uint32_t rate;
  uint8_t channels;
};
struct pa_buffer_attr {
  uint32_t maxlength, tlength, prebuf, minreq, fragsize;
};
using pa_usec_t = uint64_t;

int64_t nowTc() {
  timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (int64_t)t.tv_sec * 10000000 + t.tv_nsec / 100;
}

namespace {
std::atomic<bool> stopping{false};
std::thread worker;
pa_simple* stream = nullptr;
pa_simple* (*simpleNew)(const char*, const char*, int, const char*, const char*, const pa_sample_spec*, const void*,
                        const pa_buffer_attr*, int*) = nullptr;
int (*simpleRead)(pa_simple*, void*, size_t, int*) = nullptr;
pa_usec_t (*simpleLatency)(pa_simple*, int*) = nullptr;
void (*simpleFree)(pa_simple*) = nullptr;
}  // namespace

bool startAppAudio(unsigned long, AudioSink* sink, std::string& why) {
  void* lib = dlopen("libpulse-simple.so.0", RTLD_NOW);
  if (!lib) {
    why = "libpulse-simple.so.0 not found";
    return false;
  }
  simpleNew = (decltype(simpleNew))dlsym(lib, "pa_simple_new");
  simpleRead = (decltype(simpleRead))dlsym(lib, "pa_simple_read");
  simpleLatency = (decltype(simpleLatency))dlsym(lib, "pa_simple_get_latency");
  simpleFree = (decltype(simpleFree))dlsym(lib, "pa_simple_free");
  if (!simpleNew || !simpleRead || !simpleLatency || !simpleFree) {
    why = "libpulse-simple without the functions it should have";
    return false;
  }
  const int rate = 48000, frames = 480;  // 10 ms
  pa_sample_spec spec{5, rate, 2};
  pa_buffer_attr attr{(uint32_t)-1, (uint32_t)-1, (uint32_t)-1, (uint32_t)-1, frames * 8};
  int error = 0;
  stream = simpleNew(nullptr, "Lumina Live", 2 /* PA_STREAM_RECORD */, "@DEFAULT_MONITOR@", "NDI audio", &spec, nullptr,
                     &attr, &error);
  if (!stream) {
    why = "pa_simple_new " + std::to_string(error);
    return false;
  }
  stopping = false;
  worker = std::thread([sink] {
    std::vector<float> buf(frames * 2);
    int err = 0;
    while (!stopping && simpleRead(stream, buf.data(), buf.size() * sizeof(float), &err) == 0) {
      int64_t latency = (int64_t)simpleLatency(stream, &err) * 10;  // µs → 100 ns
      sink->push(buf.data(), frames, 2, rate, nowTc() - latency - (int64_t)frames * 10000000 / rate);
    }
  });
  return true;
}

void stopAppAudio() {
  stopping = true;
  if (worker.joinable()) worker.join();
  if (stream) simpleFree(stream);
  stream = nullptr;
}
