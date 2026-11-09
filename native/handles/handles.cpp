// Node-API addon for Electron main: takes the engine's shared textures into main, and hands the NDI output
// engine the offscreen window's (native/engine/ndi.cpp), which Node can't do on its own. No other
// dependency, so nothing to clash with Chromium's own libraries.
//   macOS: lookup(id) -> IOSurfaceRef as a decimal string (main's own reference) · release(pointer)
//          machLookup(service) -> send right · machSendSurface(port, ioSurface Buffer) -> sent? · machRelease(port)
//   Linux: listen(path) -> server fd · accept(server, timeoutMs) -> fds[] (SCM_RIGHTS) · close(fd)
//          connect(path) -> fd (SOCK_SEQPACKET) · sendFds(fd, text, fds[]) -> sent?
// Windows needs none: the engines duplicate handles across processes themselves.
#include <node_api.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static napi_value fail(napi_env env, const std::string& why) {
  napi_throw_error(env, nullptr, why.c_str());
  return nullptr;
}
static std::vector<napi_value> args(napi_env env, napi_callback_info info, size_t count) {
  std::vector<napi_value> v(count);
  napi_get_cb_info(env, info, &count, v.data(), nullptr, nullptr);
  return v;
}

#ifdef __APPLE__
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

static napi_value Lookup(napi_env env, napi_callback_info info) {
  uint32_t id = 0;
  napi_get_value_uint32(env, args(env, info, 1)[0], &id);
  IOSurfaceRef s = IOSurfaceLookup(id);
  if (!s) return fail(env, "IOSurfaceLookup(" + std::to_string(id) + ") found nothing");
  std::string p = std::to_string((unsigned long long)(uintptr_t)s);
  napi_value out;
  napi_create_string_utf8(env, p.c_str(), p.size(), &out);
  return out;
}

static napi_value Release(napi_env env, napi_callback_info info) {
  char b[32] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, args(env, info, 1)[0], b, sizeof b, &len);
  if (auto p = (IOSurfaceRef)(uintptr_t)strtoull(b, nullptr, 10)) CFRelease(p);
  return nullptr;
}

// The NDI output engine checked in a launchd name; this is the send right to it.
static napi_value MachLookup(napi_env env, napi_callback_info info) {
  char name[128] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, args(env, info, 1)[0], name, sizeof name, &len);
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t kr = bootstrap_look_up(bootstrap_port, name, &port);
  if (kr != KERN_SUCCESS) return fail(env, std::string("bootstrap_look_up(") + name + "): " + bootstrap_strerror(kr));
  napi_value out;
  napi_create_uint32(env, port, &out);
  return out;
}

// An offscreen paint's IOSurface (Electron's, local to this process) as a mach port, which moves to the
// engine. Never blocks: false when the engine is gone or behind, and main simply releases that frame.
static napi_value MachSendSurface(napi_env env, napi_callback_info info) {
  auto v = args(env, info, 2);
  uint32_t port = 0;
  napi_get_value_uint32(env, v[0], &port);
  void* data = nullptr;
  size_t len = 0;
  napi_get_buffer_info(env, v[1], &data, &len);
  bool sent = false;
  if (len >= sizeof(IOSurfaceRef)) {
    IOSurfaceRef surface;
    memcpy(&surface, data, sizeof surface);
    struct {
      mach_msg_header_t header;
      mach_msg_body_t body;
      mach_msg_port_descriptor_t surface;
    } m{};
    m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    m.header.msgh_size = sizeof m;
    m.header.msgh_remote_port = port;
    m.body.msgh_descriptor_count = 1;
    m.surface.name = IOSurfaceCreateMachPort(surface);
    m.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    m.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    sent = m.surface.name != MACH_PORT_NULL &&
           mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof m, 0, MACH_PORT_NULL, 0, MACH_PORT_NULL) == KERN_SUCCESS;
    if (!sent && m.surface.name != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), m.surface.name);
  }
  napi_value out;
  napi_get_boolean(env, sent, &out);
  return out;
}

static napi_value MachRelease(napi_env env, napi_callback_info info) {
  uint32_t port = 0;
  napi_get_value_uint32(env, args(env, info, 1)[0], &port);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"lookup", nullptr, Lookup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"machLookup", nullptr, MachLookup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"machSendSurface", nullptr, MachSendSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"machRelease", nullptr, MachRelease, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 5, props);
  return exports;
}

#else
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static napi_value Listen(napi_env env, napi_callback_info info) {
  char path[108] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, args(env, info, 1)[0], path, sizeof path, &len);
  unlink(path);
  int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  memcpy(a.sun_path, path, len);
  if (s < 0 || bind(s, (sockaddr*)&a, sizeof a) < 0 || listen(s, 1) < 0) return fail(env, std::string("listen ") + path + ": " + strerror(errno));
  napi_value out;
  napi_create_int32(env, s, &out);
  return out;
}

// Called once the engine's slots event arrived, so the connection is already waiting.
static napi_value Accept(napi_env env, napi_callback_info info) {
  auto v = args(env, info, 2);
  int32_t s = -1, timeout = 1000;
  napi_get_value_int32(env, v[0], &s);
  napi_get_value_int32(env, v[1], &timeout);
  pollfd p{s, POLLIN, 0};
  if (poll(&p, 1, timeout) != 1) return fail(env, "the engine did not send its buffers");
  int c = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
  if (c < 0) return fail(env, std::string("accept: ") + strerror(errno));
  char byte;
  iovec io{&byte, 1};
  std::vector<char> buf(CMSG_SPACE(sizeof(int) * 64));
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = buf.data();
  msg.msg_controllen = buf.size();
  ssize_t n = recvmsg(c, &msg, MSG_CMSG_CLOEXEC);
  close(c);
  if (n < 0) return fail(env, std::string("recvmsg: ") + strerror(errno));
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t k = 0;
  for (cmsghdr* h = CMSG_FIRSTHDR(&msg); h; h = CMSG_NXTHDR(&msg, h)) {
    if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS) continue;
    size_t count = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    for (size_t i = 0; i < count; i++) {
      int fd;
      memcpy(&fd, CMSG_DATA(h) + i * sizeof(int), sizeof fd);
      napi_value fdv;
      napi_create_int32(env, fd, &fdv);
      napi_set_element(env, arr, k++, fdv);
    }
  }
  return arr;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  napi_get_value_int32(env, args(env, info, 1)[0], &fd);
  if (fd >= 0) close(fd);
  return nullptr;
}

// The NDI output engine listens here; one connection for all its frames.
static napi_value Connect(napi_env env, napi_callback_info info) {
  char path[108] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, args(env, info, 1)[0], path, sizeof path, &len);
  int s = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  memcpy(a.sun_path, path, len);
  if (s < 0 || connect(s, (sockaddr*)&a, sizeof a) < 0) {
    if (s >= 0) close(s);
    return fail(env, std::string("connect ") + path + ": " + strerror(errno));
  }
  napi_value out;
  napi_create_int32(env, s, &out);
  return out;
}

// One frame: its description as text and its dmabuf fds (SCM_RIGHTS: the kernel dups them into the engine,
// so Electron's own stay with the texture until main releases it). Never blocks: false = not sent.
static napi_value SendFds(napi_env env, napi_callback_info info) {
  auto v = args(env, info, 3);
  int32_t s = -1;
  napi_get_value_int32(env, v[0], &s);
  char text[256] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, v[1], text, sizeof text, &len);
  uint32_t count = 0;
  napi_get_array_length(env, v[2], &count);
  std::vector<int> fds;
  for (uint32_t i = 0; i < count && i < 4; i++) {
    napi_value e;
    int32_t fd = -1;
    napi_get_element(env, v[2], i, &e);
    napi_get_value_int32(env, e, &fd);
    fds.push_back(fd);
  }
  iovec io{text, len};
  std::vector<char> buf(CMSG_SPACE(sizeof(int) * (fds.empty() ? 1 : fds.size())));
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  if (!fds.empty()) {
    msg.msg_control = buf.data();
    msg.msg_controllen = CMSG_SPACE(sizeof(int) * fds.size());
    cmsghdr* c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int) * fds.size());
    memcpy(CMSG_DATA(c), fds.data(), sizeof(int) * fds.size());
  }
  napi_value out;
  napi_get_boolean(env, sendmsg(s, &msg, MSG_DONTWAIT | MSG_NOSIGNAL) >= 0, &out);
  return out;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"listen", nullptr, Listen, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"accept", nullptr, Accept, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"sendFds", nullptr, SendFds, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 5, props);
  return exports;
}
#endif
