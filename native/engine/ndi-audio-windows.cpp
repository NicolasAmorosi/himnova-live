// Windows: the app's sound through WASAPI process loopback (Windows 10 2004 / build 19041+, as OBS's application
// audio): Electron main's process tree — Chromium's audio service and every media engine are its children — as
// 48 kHz stereo float, whatever the device mixes at. No permission prompt. The loopback says nothing while the app is
// silent, so it is polled as well as waited on; the gaps are filled with silence downstream (ndi.cpp).
// With PREVIEW on another output (proto 8) the process tree would carry PREVIEW too, and Windows has no loopback of one
// process on one device: the LIVE output's endpoint loopback instead, which also carries any other app sounding there
// (accepted by the owner, 2026-11-15, D6). mpv names an endpoint «wasapi/<its endpoint id>».
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
std::atomic<bool> stopping{false}, broken{false};
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

// The Windows Audio service's process: a new one (the service restarted) leaves a process loopback alive but deaf, with
// no error from any call (measured 2026-11-15, `Restart-Service audiosrv`): the capture is started again.
DWORD audioServicePid() {
  DWORD pid = 0;
  if (SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)) {
    if (SC_HANDLE service = OpenServiceW(scm, L"audiosrv", SERVICE_QUERY_STATUS)) {
      SERVICE_STATUS_PROCESS status{};
      DWORD size = 0;
      if (QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE*)&status, sizeof status, &size)) pid = status.dwProcessId;
      CloseServiceHandle(service);
    }
    CloseServiceHandle(scm);
  }
  return pid;
}

// The default output's endpoint id, empty when there is none.
std::wstring defaultId(IMMDeviceEnumerator* devices) {
  IMMDevice* device = nullptr;
  LPWSTR id = nullptr;
  std::wstring out;
  if (SUCCEEDED(devices->GetDefaultAudioEndpoint(eRender, eConsole, &device))) {
    if (SUCCEEDED(device->GetId(&id))) out = id, CoTaskMemFree(id);
    device->Release();
  }
  return out;
}

// The output's IAudioClient: `guid` as mpv names it (the endpoint id's last part, «{…}»), or empty for the default.
HRESULT endpointClient(IMMDeviceEnumerator* devices, const std::wstring& guid, IAudioClient** client) {
  IMMDevice* device = nullptr;
  HRESULT hr = S_OK;
  if (guid.empty()) hr = devices->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  else {
    IMMDeviceCollection* all = nullptr;
    hr = devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &all);
    UINT n = 0;
    if (SUCCEEDED(hr)) all->GetCount(&n);
    for (UINT i = 0; i < n && !device; i++) {
      IMMDevice* d = nullptr;
      LPWSTR id = nullptr;
      if (FAILED(all->Item(i, &d))) continue;
      if (SUCCEEDED(d->GetId(&id))) {
        std::wstring full(id);
        if (full.size() >= guid.size() && full.compare(full.size() - guid.size(), guid.size(), guid) == 0) device = d;
        CoTaskMemFree(id);
      }
      if (device != d) d->Release();
    }
    if (all) all->Release();
    if (SUCCEEDED(hr) && !device) hr = E_NOTFOUND;  // unplugged
  }
  if (FAILED(hr)) return hr;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client);
  device->Release();
  return hr;
}

void capture(DWORD appPid, AudioRoute route, AudioSink* sink, HANDLE started, std::string* why) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IMMDeviceEnumerator* devices = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capturer = nullptr;
  auto failed = [&](const char* what, HRESULT hr) {
    char b[96];
    snprintf(b, sizeof b, "%s 0x%08lx", what, (unsigned long)hr);
    *why = b;
    if (capturer) capturer->Release();
    if (client) client->Release();
    if (devices) devices->Release();
    CoUninitialize();
    SetEvent(started);
  };
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&devices);
  if (FAILED(hr)) return failed("MMDeviceEnumerator", hr);
  // «auto» with PREVIEW apart is the default output's loopback: when the default moves, the capture must follow it.
  std::wstring followed;
  if (route.previewApart) {
    const std::string prefix = "wasapi/";
    std::wstring id;
    if (route.device.compare(0, prefix.size(), prefix) == 0) {
      std::string utf8 = route.device.substr(prefix.size());
      id.resize(MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0));
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), id.data(), (int)id.size());
    }
    if (id.empty()) followed = defaultId(devices);
    hr = endpointClient(devices, id, &client);
    if (FAILED(hr)) return failed("endpoint loopback", hr);
  } else {
    AUDIOCLIENT_ACTIVATION_PARAMS params{AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, {appPid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE}};
    PROPVARIANT activation{};
    activation.vt = VT_BLOB;
    activation.blob.cbSize = sizeof params;
    activation.blob.pBlobData = (BYTE*)&params;
    static Activated handler;
    ResetEvent(handler.done);
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    hr = ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &activation, &handler, &op);
    if (FAILED(hr)) return failed("ActivateAudioInterfaceAsync", hr);
    WaitForSingleObject(handler.done, 5000);
    HRESULT result = E_FAIL;
    IUnknown* unknown = nullptr;
    op->GetActivateResult(&result, &unknown);
    op->Release();
    // Before Windows 10 2004 this is where it says no.
    if (FAILED(result) || !unknown) return failed("process loopback", result);
    hr = unknown->QueryInterface(__uuidof(IAudioClient), (void**)&client);
    unknown->Release();
    if (FAILED(hr)) return failed("IAudioClient", hr);
  }
  WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 48000 * 8, 8, 32, 0};
  const DWORD loopback = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  const DWORD convert = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | (route.previewApart ? AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY : 0);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, loopback | convert, 200000, 0, &format, nullptr);
  int channels = 2, rate = 48000;
  if (FAILED(hr) && route.previewApart) {
    // An endpoint that will not convert: its own mix format, which is 32-bit float on every shared-mode device.
    WAVEFORMATEX* mix = nullptr;
    if (SUCCEEDED(client->GetMixFormat(&mix)) && mix->wBitsPerSample == 32) {
      hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, loopback, 200000, 0, mix, nullptr);
      channels = mix->nChannels;
      rate = (int)mix->nSamplesPerSec;
    }
    CoTaskMemFree(mix);
  }
  if (FAILED(hr)) return failed("IAudioClient::Initialize", hr);
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(ready);
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capturer);
  if (FAILED(hr)) return CloseHandle(ready), failed("IAudioCaptureClient", hr);
  hr = client->Start();
  if (FAILED(hr)) return CloseHandle(ready), failed("IAudioClient::Start", hr);
  SetEvent(started);
  LARGE_INTEGER hz;
  QueryPerformanceFrequency(&hz);
  ULONGLONG lastLook = GetTickCount64();
  const DWORD service = audioServicePid();
  // A failed call (AUDCLNT_E_DEVICE_INVALIDATED: the output unplugged or disabled) ends the capture and says so: before,
  // the loop went on asking a dead client with the state still «on».
  while (!stopping && !broken) {
    WaitForSingleObject(ready, 10);
    if (GetTickCount64() - lastLook >= 1000) {
      lastLook = GetTickCount64();
      if (audioServicePid() != service || (!followed.empty() && defaultId(devices) != followed)) broken = true;
    }
    UINT32 frames = 0;
    for (;;) {
      if (FAILED(capturer->GetNextPacketSize(&frames))) broken = true;
      if (broken || !frames) break;
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 qpc = 0;  // when its first sample was captured, in 100 ns of the performance counter
      if (FAILED(capturer->GetBuffer(&data, &frames, &flags, nullptr, &qpc))) {
        broken = true;
        break;
      }
      LARGE_INTEGER now;
      QueryPerformanceCounter(&now);
      int64_t age = (int64_t)((double)now.QuadPart * 1e7 / (double)hz.QuadPart) - (int64_t)qpc;
      if (age < 0 || age > 10000000) age = 0;
      sink->push(flags & AUDCLNT_BUFFERFLAGS_SILENT ? nullptr : (const float*)data, (int)frames, channels, rate, nowTc() - age);
      capturer->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  capturer->Release();
  client->Release();
  devices->Release();
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

bool startAppAudio(unsigned long appPid, const AudioRoute& route, AudioSink* sink, std::string& why) {
  stopping = broken = false;
  static SilenceAware wrapped(nullptr);
  wrapped.to = sink;
  wrapper = &wrapped;
  HANDLE started = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::string reason;
  worker = std::thread(capture, (DWORD)appPid, route, wrapper, started, &reason);
  WaitForSingleObject(started, 8000);
  CloseHandle(started);
  if (reason.empty()) return true;
  worker.join();
  why = reason;
  return false;
}

bool appAudioHealthy() { return !broken; }

void stopAppAudio() {
  stopping = true;
  if (worker.joinable()) worker.join();
}
