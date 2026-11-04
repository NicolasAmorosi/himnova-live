// Windows: libmpv's Direct3D 11 render API (mpv master since 2026-04-17, pinned build) draws on OUR
// device, so d3d11va decodes on it with no copy, and mpv converts and scales into each BGRA slot. A keyed
// mutex orders that against Electron's GPU process. Each slot's NT handle is duplicated into main, which
// imports it; releaseShared() closes those copies when the engine quits.
#define WIN32_LEAN_AND_MEAN
#include "gpu.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

// From mpv's include/mpv/render_d3d11.h (ISC), which the Windows dev package leaves out.
struct mpv_d3d11_init_params { void* device; };
struct mpv_d3d11_fbo { void* tex; };

struct Gpu::State {
  ID3D11Device* dev = nullptr;
  HANDLE parent = nullptr;
  mpv_d3d11_init_params init{};
  struct Target { ID3D11Texture2D* tex = nullptr; IDXGIKeyedMutex* mutex = nullptr; HANDLE inParent = nullptr; };
  std::vector<Target> ring;
  mpv_d3d11_fbo fbo{};
};

static std::string hex(HRESULT hr) { char b[16]; snprintf(b, sizeof b, "0x%08lx", (unsigned long)hr); return b; }

Gpu::Gpu(const GpuOptions& o) : s(new State), options(o) {}

Gpu::~Gpu() {
  for (auto& t : s->ring) { t.mutex->Release(); t.tex->Release(); }
  if (s->dev) s->dev->Release();
  if (s->parent) CloseHandle(s->parent);
  delete s;
}

void Gpu::init() {
  if (!(s->parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, (DWORD)options.parentPid)))
    fail("engine-gpu", "OpenProcess(parent) " + std::to_string(GetLastError()));
  D3D_FEATURE_LEVEL level;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                 nullptr, 0, D3D11_SDK_VERSION, &s->dev, &level, nullptr);
  if (FAILED(hr)) fail("engine-gpu", "D3D11CreateDevice " + hex(hr));
  IDXGIDevice* dxgi = nullptr;
  IDXGIAdapter* adapter = nullptr;
  DXGI_ADAPTER_DESC d{};
  if (SUCCEEDED(s->dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgi)) && SUCCEEDED(dxgi->GetAdapter(&adapter))) adapter->GetDesc(&d);
  if (adapter) adapter->Release();
  if (dxgi) dxgi->Release();
  char name[256];
  WideCharToMultiByte(CP_UTF8, 0, d.Description, -1, name, sizeof name, nullptr, nullptr);
  describe = std::string("D3D11 ") + name;
  s->init = {s->dev};
}

void Gpu::renderContextParams(std::vector<mpv_render_param>& p) {
  p.push_back({MPV_RENDER_PARAM_API_TYPE, (void*)"d3d11"});
  p.push_back({(mpv_render_param_type)MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &s->init});
}

std::string Gpu::createRing(int width, int height, int count) {
  std::string handles;
  for (int i = 0; i < count; i++) {
    D3D11_TEXTURE2D_DESC td{};
    td.Width = width; td.Height = height; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    td.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    State::Target t;
    HRESULT hr;
    if (FAILED(hr = s->dev->CreateTexture2D(&td, nullptr, &t.tex))) fail("engine-gpu", "CreateTexture2D(shared) " + hex(hr));
    if (FAILED(hr = t.tex->QueryInterface(__uuidof(IDXGIKeyedMutex), (void**)&t.mutex))) fail("engine-gpu", "IDXGIKeyedMutex " + hex(hr));
    IDXGIResource1* res = nullptr;
    if (FAILED(hr = t.tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&res))) fail("engine-gpu", "IDXGIResource1 " + hex(hr));
    HANDLE local = nullptr;
    hr = res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &local);
    res->Release();
    if (FAILED(hr)) fail("engine-gpu", "CreateSharedHandle " + hex(hr));
    BOOL duplicated = DuplicateHandle(GetCurrentProcess(), local, s->parent, &t.inParent, 0, FALSE, DUPLICATE_SAME_ACCESS);
    CloseHandle(local);
    if (!duplicated) fail("engine-gpu", "DuplicateHandle into main " + std::to_string(GetLastError()));
    s->ring.push_back(t);
    handles += (i ? ",\"" : "\"") + std::to_string((unsigned long long)(uintptr_t)t.inParent) + "\"";
  }
  return "[" + handles + "]";
}

bool Gpu::beginFrame(int slot, std::vector<mpv_render_param>& p) {
  if (s->ring[slot].mutex->AcquireSync(0, 1000) != S_OK) return false;
  s->fbo = {s->ring[slot].tex};
  p.push_back({(mpv_render_param_type)MPV_RENDER_PARAM_D3D11_FBO, &s->fbo});
  return true;
}

void Gpu::endFrame(int slot) { s->ring[slot].mutex->ReleaseSync(0); }

// DUPLICATE_CLOSE_SOURCE closes the handle inside main. main never closes them itself (Node has no
// CloseHandle), so an engine that crashed leaves its ring alive in main until the next engine closes it:
// main passes the dead engine's handles to the next one (--close-in-parent).
void Gpu::releaseShared() {
  for (auto& t : s->ring)
    if (t.inParent) DuplicateHandle(s->parent, t.inParent, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
}

void closeInParent(unsigned long parentPid, const std::vector<unsigned long long>& handles) {
  HANDLE parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, (DWORD)parentPid);
  if (!parent) return;
  for (auto h : handles) DuplicateHandle(parent, (HANDLE)(uintptr_t)h, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
  CloseHandle(parent);
}
