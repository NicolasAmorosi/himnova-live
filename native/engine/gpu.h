// The render targets mpv draws into, shared with Electron's GPU process. One implementation per OS:
//   gpu-apple.cpp    CGL + rectangle textures on global BGRA IOSurfaces
//   gpu-linux.cpp    EGL on the render node (GBM, surfaceless) + linear ARGB8888 dmabufs
//   gpu-windows.cpp  libmpv's D3D11 render API on our own device + NT-handle textures with a keyed mutex
// Everything here runs on the render thread, which owns the context.
#pragma once
#include <mpv/render.h>

#include <string>
#include <vector>

struct Fail {
  std::string code;  // stable, for the app to map to a message: engine-gpu, engine-open, ...
  std::string detail;
};
[[noreturn]] inline void fail(const std::string& code, const std::string& detail) { throw Fail{code, detail}; }

struct GpuOptions {
  unsigned long parentPid = 0;  // Windows: the handles are duplicated into this process
  std::string fdSocket;         // Linux: the dmabuf fds go to main over this Unix socket
};

struct Gpu {
  explicit Gpu(const GpuOptions& options);
  ~Gpu();
  // Creates the device or context. Throws Fail.
  void init();
  // What mpv_render_context_create needs besides MPV_RENDER_PARAM_INVALID.
  void renderContextParams(std::vector<mpv_render_param>& params);
  // `count` targets of width×height. Returns the "handles" JSON array of the slots event: what main
  // needs to import each target (IOSurface IDs, handle values in main, or the dmabuf layout).
  std::string createRing(int width, int height, int count);
  // Before mpv renders into `slot`: fills the FBO parameter. Returns false if the slot can't be used.
  bool beginFrame(int slot, std::vector<mpv_render_param>& params);
  // After: makes sure the GPU finished, so Electron reads a whole frame.
  void endFrame(int slot);
  // Windows: closes the handles duplicated into main, so the textures don't outlive the engine.
  void releaseShared();
  std::string describe;

 private:
  struct State;
  State* s;
  GpuOptions options;
};
