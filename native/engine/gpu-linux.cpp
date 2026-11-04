// Linux: an EGL context on the render node (GBM platform, surfaceless) renders into textures backed by
// linear ARGB8888 GBM dmabufs. Linear is what both Wayland and X11 import at full rate (Y-tiled VA
// surfaces stalled X11 at 1–3 fps, measured 2026-10-29). The fds reach main once, over a Unix socket
// (SCM_RIGHTS), before the slots event; main receives them with native/handles.
#include "gpu.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GL/gl.h>
#include <drm_fourcc.h>
#include <fcntl.h>
#include <gbm.h>
#include <mpv/render_gl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

#ifndef GL_FRAMEBUFFER
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#endif

struct Gpu::State {
  int fd = -1;
  gbm_device* gbm = nullptr;
  EGLDisplay dpy = EGL_NO_DISPLAY;
  EGLContext ctx = EGL_NO_CONTEXT;
  mpv_opengl_init_params init{};
  // VA-API gets its OWN fd of the node: GEM handles live per fd, and iHD decoding on the fd Mesa's
  // GBM/EGL also used failed with "decode issue 23" (measured 2026-10-29). Frames still cross as dmabufs.
  mpv_opengl_drm_params_v2 drm{-1, 0, 0, nullptr, -1};
  struct Target { gbm_bo* bo = nullptr; int fd = -1; GLuint tex = 0, fbo = 0; };
  std::vector<Target> ring;
  int width = 0, height = 0;
  mpv_opengl_fbo fbo{};
  int flip = 0;  // into an FBO mpv already writes the top row first, which is how Chromium reads it
  PFNEGLCREATEIMAGEKHRPROC createImage = nullptr;
  void (*imageTargetTexture)(GLenum, void*) = nullptr;
  void (*genFramebuffers)(GLsizei, GLuint*) = nullptr;
  void (*bindFramebuffer)(GLenum, GLuint) = nullptr;
  void (*framebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint) = nullptr;
  GLenum (*checkFramebufferStatus)(GLenum) = nullptr;
  void (*finish)() = nullptr;
};

template <typename F>
static void load(F& f, const char* name) {
  if (!(f = (F)eglGetProcAddress(name))) fail("engine-gpu", std::string("missing ") + name);
}
static void* procAddress(void*, const char* name) { return (void*)eglGetProcAddress(name); }

Gpu::Gpu(const GpuOptions& o) : s(new State), options(o) {}

Gpu::~Gpu() {
  for (auto& t : s->ring) { close(t.fd); gbm_bo_destroy(t.bo); }
  if (s->dpy != EGL_NO_DISPLAY) {
    eglMakeCurrent(s->dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (s->ctx != EGL_NO_CONTEXT) eglDestroyContext(s->dpy, s->ctx);
    eglTerminate(s->dpy);
  }
  if (s->gbm) gbm_device_destroy(s->gbm);
  if (s->fd >= 0) close(s->fd);
  if (s->drm.render_fd >= 0) close(s->drm.render_fd);
  delete s;
}

void Gpu::init() {
  std::string node;
  for (int i = 128; i < 136 && s->fd < 0; i++) s->fd = open((node = "/dev/dri/renderD" + std::to_string(i)).c_str(), O_RDWR | O_CLOEXEC);
  if (s->fd < 0) fail("engine-gpu", "no /dev/dri/renderD* could be opened");
  if (!(s->gbm = gbm_create_device(s->fd))) fail("engine-gpu", "gbm_create_device");
  auto getPlatformDisplay = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  if (!getPlatformDisplay) fail("engine-gpu", "eglGetPlatformDisplayEXT");
  s->dpy = getPlatformDisplay(EGL_PLATFORM_GBM_KHR, s->gbm, nullptr);
  if (s->dpy == EGL_NO_DISPLAY || !eglInitialize(s->dpy, nullptr, nullptr)) fail("engine-gpu", "eglInitialize(GBM)");
  if (!eglBindAPI(EGL_OPENGL_API)) fail("engine-gpu", "eglBindAPI(OpenGL)");
  EGLint cattrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE};
  EGLConfig cfg;
  EGLint n = 0;
  if (!eglChooseConfig(s->dpy, cattrs, &cfg, 1, &n) || n < 1) fail("engine-gpu", "eglChooseConfig");
  EGLint xattrs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3, EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE};
  if ((s->ctx = eglCreateContext(s->dpy, cfg, EGL_NO_CONTEXT, xattrs)) == EGL_NO_CONTEXT) fail("engine-gpu", "eglCreateContext(OpenGL 3.3 core)");
  if (!eglMakeCurrent(s->dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, s->ctx)) fail("engine-gpu", "eglMakeCurrent(surfaceless)");
  load(s->createImage, "eglCreateImageKHR");
  load(s->imageTargetTexture, "glEGLImageTargetTexture2DOES");
  load(s->genFramebuffers, "glGenFramebuffers");
  load(s->bindFramebuffer, "glBindFramebuffer");
  load(s->framebufferTexture2D, "glFramebufferTexture2D");
  load(s->checkFramebufferStatus, "glCheckFramebufferStatus");
  load(s->finish, "glFinish");
  auto getString = (const GLubyte* (*)(GLenum))eglGetProcAddress("glGetString");
  describe = std::string("EGL/GBM ") + (const char*)getString(GL_RENDERER);
  if ((s->drm.render_fd = open(node.c_str(), O_RDWR | O_CLOEXEC)) < 0) fail("engine-gpu", "reopen " + node);
  s->init = {procAddress, nullptr};
}

void Gpu::renderContextParams(std::vector<mpv_render_param>& p) {
  p.push_back({MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_OPENGL});
  p.push_back({MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &s->init});
  p.push_back({MPV_RENDER_PARAM_DRM_DISPLAY_V2, &s->drm});
}

// Every slot's fd in one SCM_RIGHTS message; main keeps them and Electron dups them per import.
static void sendFds(const std::string& path, const std::vector<int>& fds) {
  int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, path.c_str(), sizeof a.sun_path - 1);
  if (sock < 0 || connect(sock, (sockaddr*)&a, sizeof a) < 0) fail("engine-gpu", "connect " + path + ": " + strerror(errno));
  char byte = 'f';
  iovec io{&byte, 1};
  std::vector<char> buf(CMSG_SPACE(sizeof(int) * fds.size()));
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = buf.data();
  msg.msg_controllen = buf.size();
  cmsghdr* c = CMSG_FIRSTHDR(&msg);
  c->cmsg_level = SOL_SOCKET;
  c->cmsg_type = SCM_RIGHTS;
  c->cmsg_len = CMSG_LEN(sizeof(int) * fds.size());
  memcpy(CMSG_DATA(c), fds.data(), sizeof(int) * fds.size());
  ssize_t sent = sendmsg(sock, &msg, 0);
  close(sock);
  if (sent < 0) fail("engine-gpu", std::string("sendmsg(SCM_RIGHTS): ") + strerror(errno));
}

std::string Gpu::createRing(int width, int height, int count) {
  s->width = width;
  s->height = height;
  std::vector<int> fds;
  std::string planes;
  for (int i = 0; i < count; i++) {
    State::Target t;
    if (!(t.bo = gbm_bo_create(s->gbm, width, height, GBM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING)))
      fail("engine-gpu", "gbm_bo_create(ARGB8888, linear)");
    t.fd = gbm_bo_get_fd(t.bo);
    EGLint stride = (EGLint)gbm_bo_get_stride(t.bo);
    EGLint attrs[] = {EGL_WIDTH, width, EGL_HEIGHT, height, EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_ARGB8888, EGL_DMA_BUF_PLANE0_FD_EXT, t.fd,
                      EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0, EGL_DMA_BUF_PLANE0_PITCH_EXT, stride, EGL_NONE};
    EGLImageKHR img = s->createImage(s->dpy, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
    if (img == EGL_NO_IMAGE_KHR) fail("engine-gpu", "eglCreateImageKHR(dmabuf) " + std::to_string(eglGetError()));
    glGenTextures(1, &t.tex);
    glBindTexture(GL_TEXTURE_2D, t.tex);
    s->imageTargetTexture(GL_TEXTURE_2D, img);
    s->genFramebuffers(1, &t.fbo);
    s->bindFramebuffer(GL_FRAMEBUFFER, t.fbo);
    s->framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t.tex, 0);
    if (s->checkFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) fail("engine-gpu", "dmabuf framebuffer incomplete");
    s->ring.push_back(t);
    fds.push_back(t.fd);
    planes += std::string(i ? "," : "") + "{\"stride\":" + std::to_string(stride) + ",\"size\":" + std::to_string((long long)stride * height) + "}";
  }
  sendFds(options.fdSocket, fds);
  return "[" + planes + "]";
}

bool Gpu::beginFrame(int slot, std::vector<mpv_render_param>& p) {
  s->fbo = {(int)s->ring[slot].fbo, s->width, s->height, 0};
  p.push_back({MPV_RENDER_PARAM_OPENGL_FBO, &s->fbo});
  p.push_back({MPV_RENDER_PARAM_FLIP_Y, &s->flip});
  return true;
}

void Gpu::endFrame(int) { s->finish(); }

void Gpu::releaseShared() {}
