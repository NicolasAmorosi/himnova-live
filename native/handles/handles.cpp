// Node-API addon for Electron main: takes the engine's shared textures into main, which Node can't do on
// its own. No other dependency, so nothing to clash with Chromium's own libraries.
//   macOS: lookup(id) -> IOSurfaceRef as a decimal string (main's own reference) · release(pointer)
//   Linux: listen(path) -> server fd · accept(server, timeoutMs) -> fds[] (SCM_RIGHTS) · close(fd)
// Windows needs none: the engine duplicates its handles straight into main.
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

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"lookup", nullptr, Lookup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, props);
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

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"listen", nullptr, Listen, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"accept", nullptr, Accept, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, props);
  return exports;
}
#endif
