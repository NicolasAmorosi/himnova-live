// Linux: the engine uses the system's libmpv, and the distros ship two sonames of it: libmpv.so.2 (mpv 0.35+)
// and libmpv.so.1 (mpv 0.34, Ubuntu 22.04). Linking with -lmpv would pin the one of the build machine, so
// every libmpv function the engine calls is defined here and forwarded to whichever of the two this machine
// has. The calls below are the same in both: the 2.0 soname bump only removed APIs the engine never used.
// A new mpv_* call in the engine fails to link until it is added here.
#include <dlfcn.h>
#include <mpv/client.h>
#include <mpv/render.h>

#include <cstdio>
#include <cstdlib>
#include <initializer_list>

static void* symbol(const char* name) {
  static void* lib = [] {
    for (const char* soname : {"libmpv.so.2", "libmpv.so.1"})
      if (void* handle = dlopen(soname, RTLD_NOW | RTLD_LOCAL)) return handle;
    // Main keeps the stderr tail of an engine that exits: this is what main.log shows.
    fprintf(stderr, "libmpv not found (libmpv.so.2 or libmpv.so.1): install the distribution's libmpv package\n");
    exit(1);
  }();
  void* fn = dlsym(lib, name);
  if (!fn) {
    fprintf(stderr, "libmpv has no %s\n", name);
    exit(1);
  }
  return fn;
}

#define FORWARD(ret, name, params, args)                                              \
  ret name params {                                                                   \
    static const auto fn = reinterpret_cast<decltype(&name)>(symbol(#name));          \
    return fn args;                                                                   \
  }

FORWARD(mpv_handle*, mpv_create, (void), ())
FORWARD(int, mpv_initialize, (mpv_handle * ctx), (ctx))
FORWARD(void, mpv_terminate_destroy, (mpv_handle * ctx), (ctx))
FORWARD(int, mpv_set_option_string, (mpv_handle * ctx, const char* name, const char* data), (ctx, name, data))
FORWARD(int, mpv_set_property_string, (mpv_handle * ctx, const char* name, const char* data), (ctx, name, data))
FORWARD(int, mpv_get_property, (mpv_handle * ctx, const char* name, mpv_format format, void* data), (ctx, name, format, data))
FORWARD(int, mpv_observe_property, (mpv_handle * ctx, uint64_t reply, const char* name, mpv_format format), (ctx, reply, name, format))
FORWARD(int, mpv_request_log_messages, (mpv_handle * ctx, const char* level), (ctx, level))
FORWARD(int, mpv_command_async, (mpv_handle * ctx, uint64_t reply, const char** args), (ctx, reply, args))
FORWARD(mpv_event*, mpv_wait_event, (mpv_handle * ctx, double timeout), (ctx, timeout))
FORWARD(void, mpv_wakeup, (mpv_handle * ctx), (ctx))
FORWARD(const char*, mpv_error_string, (int error), (error))
FORWARD(int, mpv_render_context_create, (mpv_render_context * *res, mpv_handle* mpv, mpv_render_param* params), (res, mpv, params))
FORWARD(void, mpv_render_context_free, (mpv_render_context * ctx), (ctx))
FORWARD(int, mpv_render_context_render, (mpv_render_context * ctx, mpv_render_param* params), (ctx, params))
FORWARD(void, mpv_render_context_report_swap, (mpv_render_context * ctx), (ctx))
FORWARD(uint64_t, mpv_render_context_update, (mpv_render_context * ctx), (ctx))
FORWARD(void, mpv_render_context_set_update_callback, (mpv_render_context * ctx, mpv_render_update_fn cb, void* cb_ctx), (ctx, cb, cb_ctx))
