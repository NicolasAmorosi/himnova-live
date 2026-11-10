// Windows: the app's sound through WASAPI process loopback (Windows 10 2004 / build 19041+, as OBS's application
// audio): Electron main's process tree — Chromium's audio service and every media engine are its children — as
// 48 kHz stereo float, whatever the device mixes at. No permission prompt. The loopback says nothing while the app is
// silent, so it is polled as well as waited on; the gaps are filled with silence downstream (ndi.cpp).
#include "ndi-audio.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>

// audioclientactivationparams.h, which mingw-w64 does not ship.
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1 };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
};
struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
};

int64_t nowTc() {
  FILETIME f;
  GetSystemTimePreciseAsFileTime(&f);
  return (int64_t)(((uint64_t)f.dwHighDateTime << 32) | f.dwLowDateTime) - 116444736000000000LL;
}

namespace {
std::atomic<bool> stopping{false};
std::thread worker;

// Activation completes on another thread; this only says when.
struct Activated : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  STDMETHODIMP QueryInterface(REFIID id, void** out) override {
    if (id == IID_IUnknown || id == __uuidof(IActivateAudioInterfaceCompletionHandler))
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (id == __uuidof(IAgileObject))
      *out = static_cast<IAgileObject*>(this);
    else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }  // lives as long as the capture
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done);
    return S_OK;
  }
};

void capture(DWORD appPid, AudioSink* sink, HANDLE started, std::string* why) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  auto failed = [&](const char* what, HRESULT hr) {
    char b[96];
    snprintf(b, sizeof b, "%s 0x%08lx", what, (unsigned long)hr);
    *why = b;
    SetEvent(started);
  };
  AUDIOCLIENT_ACTIVATION_PARAMS params{AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, {appPid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE}};
  PROPVARIANT activation{};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof params;
  activation.blob.pBlobData = (BYTE*)&params;
  static Activated handler;
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &activation, &handler, &op);
  if (FAILED(hr)) return failed("ActivateAudioInterfaceAsync", hr);
  WaitForSingleObject(handler.done, 5000);
  HRESULT result = E_FAIL;
  IUnknown* unknown = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capturer = nullptr;
  op->GetActivateResult(&result, &unknown);
  op->Release();
  // Before Windows 10 2004 this is where it says no.
  if (FAILED(result) || !unknown) return failed("process loopback", result);
  hr = unknown->QueryInterface(__uuidof(IAudioClient), (void**)&client);
  unknown->Release();
  if (FAILED(hr)) return failed("IAudioClient", hr);
  WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 48000 * 8, 8, 32, 0};
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000, 0, &format, nullptr);
  if (FAILED(hr)) return failed("IAudioClient::Initialize", hr);
  client->SetEventHandle(ready);
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capturer);
  if (FAILED(hr)) return failed("IAudioCaptureClient", hr);
  hr = client->Start();
  if (FAILED(hr)) return failed("IAudioClient::Start", hr);
  SetEvent(started);
  LARGE_INTEGER hz;
  QueryPerformanceFrequency(&hz);
  while (!stopping) {
    WaitForSingleObject(ready, 10);
    UINT32 frames = 0;
    while (SUCCEEDED(capturer->GetNextPacketSize(&frames)) && frames) {
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 qpc = 0;  // when its first sample was captured, in 100 ns of the performance counter
      if (FAILED(capturer->GetBuffer(&data, &frames, &flags, nullptr, &qpc))) break;
      LARGE_INTEGER now;
      QueryPerformanceCounter(&now);
      int64_t age = (int64_t)((double)now.QuadPart * 1e7 / (double)hz.QuadPart) - (int64_t)qpc;
      if (age < 0 || age > 10000000) age = 0;
      sink->push(flags & AUDCLNT_BUFFERFLAGS_SILENT ? nullptr : (const float*)data, (int)frames, 2, 48000, nowTc() - age);
      capturer->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  capturer->Release();
  client->Release();
  CloseHandle(ready);
  CoUninitialize();
}

// A null buffer means silence: given as zeros, the way the sink expects a block.
struct SilenceAware : AudioSink {
  AudioSink* to;
  std::vector<float> zeros;
  explicit SilenceAware(AudioSink* t) : to(t) {}
  void push(const float* in, int frames, int channels, int rate, int64_t tc) override {
    if (!in) {
      zeros.assign((size_t)frames * channels, 0.f);
      in = zeros.data();
    }
    to->push(in, frames, channels, rate, tc);
  }
};
SilenceAware* wrapper = nullptr;
}  // namespace

bool startAppAudio(unsigned long appPid, AudioSink* sink, std::string& why) {
  stopping = false;
  wrapper = new SilenceAware(sink);
  HANDLE started = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::string reason;
  worker = std::thread(capture, (DWORD)appPid, wrapper, started, &reason);
  WaitForSingleObject(started, 8000);
  CloseHandle(started);
  if (reason.empty()) return true;
  worker.join();
  why = reason;
  return false;
}

void stopAppAudio() {
  stopping = true;
  if (worker.joinable()) worker.join();
}
