// macOS: a CGL context renders into rectangle textures backed by BGRA IOSurfaces. The surfaces are
// global, so main can find each one by its ID (native/handles, IOSurfaceLookup) and hand Electron an
// in-process IOSurfaceRef.
// ponytail: kIOSurfaceIsGlobal is deprecated (any local process can look a frame up by its ID); if macOS
// drops it, send IOSurfaceCreateMachPort() to main over a bootstrap rendezvous, as Chromium does.
#define GL_SILENCE_DEPRECATION
#include "gpu.h"

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <dlfcn.h>
#include <mpv/render_gl.h>

struct Gpu::State {
  CGLContextObj ctx = nullptr;
  void* lib = nullptr;
  mpv_opengl_init_params init{};
  struct Target { IOSurfaceRef surface = nullptr; GLuint tex = 0, fbo = 0; };
  std::vector<Target> ring;
  int width = 0, height = 0;
  mpv_opengl_fbo fbo{};
  int flip = 0;  // into an FBO mpv already writes the top row first, which is how Chromium reads it
};

static void* procAddress(void* lib, const char* name) { return dlsym(lib, name); }

Gpu::Gpu(const GpuOptions& o) : s(new State), options(o) {}

Gpu::~Gpu() {
  for (auto& t : s->ring) CFRelease(t.surface);
  CGLSetCurrentContext(nullptr);
  if (s->ctx) CGLDestroyContext(s->ctx);
  delete s;
}

void Gpu::init() {
  s->lib = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
  CGLPixelFormatAttribute attrs[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core, kCGLPFAAccelerated,
                                     kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0};
  CGLPixelFormatObj pf = nullptr;
  GLint n = 0;
  if (CGLChoosePixelFormat(attrs, &pf, &n) != kCGLNoError || !pf) fail("engine-gpu", "CGLChoosePixelFormat");
  CGLError e = CGLCreateContext(pf, nullptr, &s->ctx);
  CGLDestroyPixelFormat(pf);
  if (e != kCGLNoError) fail("engine-gpu", "CGLCreateContext");
  CGLSetCurrentContext(s->ctx);
  describe = std::string("CGL ") + (const char*)glGetString(GL_RENDERER);
  s->init = {procAddress, s->lib};
}

void Gpu::renderContextParams(std::vector<mpv_render_param>& p) {
  p.push_back({MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_OPENGL});
  p.push_back({MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &s->init});
}

std::string Gpu::createRing(int width, int height, int count) {
  s->width = width;
  s->height = height;
  std::string ids;
  for (int i = 0; i < count; i++) {
    int bpe = 4, fmt = 'BGRA';
    CFNumberRef w = CFNumberCreate(nullptr, kCFNumberIntType, &width), h = CFNumberCreate(nullptr, kCFNumberIntType, &height);
    CFNumberRef b = CFNumberCreate(nullptr, kCFNumberIntType, &bpe), f = CFNumberCreate(nullptr, kCFNumberIntType, &fmt);
    const void* keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat, kIOSurfaceIsGlobal};
    const void* vals[] = {w, h, b, f, kCFBooleanTrue};
    CFDictionaryRef props = CFDictionaryCreate(nullptr, keys, vals, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    State::Target t;
    t.surface = IOSurfaceCreate(props);
    CFRelease(props); CFRelease(w); CFRelease(h); CFRelease(b); CFRelease(f);
    if (!t.surface) fail("engine-gpu", "IOSurfaceCreate");
    glGenTextures(1, &t.tex);
    glBindTexture(GL_TEXTURE_RECTANGLE, t.tex);
    if (CGLTexImageIOSurface2D(s->ctx, GL_TEXTURE_RECTANGLE, GL_RGBA, width, height, GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, t.surface, 0) != kCGLNoError)
      fail("engine-gpu", "CGLTexImageIOSurface2D");
    glGenFramebuffers(1, &t.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, t.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, t.tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) fail("engine-gpu", "IOSurface framebuffer incomplete");
    s->ring.push_back(t);
    ids += (i ? "," : "") + std::to_string(IOSurfaceGetID(t.surface));
  }
  return "[" + ids + "]";
}

bool Gpu::beginFrame(int slot, std::vector<mpv_render_param>& p) {
  s->fbo = {(int)s->ring[slot].fbo, s->width, s->height, 0};
  p.push_back({MPV_RENDER_PARAM_OPENGL_FBO, &s->fbo});
  p.push_back({MPV_RENDER_PARAM_FLIP_Y, &s->flip});
  return true;
}

void Gpu::endFrame(int) { glFinish(); }

void Gpu::releaseShared() {}
