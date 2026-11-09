## Electron's offscreen textures reach another process a different way on each OS — and on Linux, GL reads them as zeros
**Area:** projection
**Trigger:** changing how the NDI engine reads frames (`Frames` in `native/engine/ndi.cpp`, `machSendSurface`/`sendFds` in `native/handles/handles.cpp`), or handing an offscreen texture to any other process

- **macOS:** `textureInfo.handle.ioSurface` is "local to current process (not global)" (Electron's own typings): `IOSurfaceLookup(id)` from another process finds nothing. What works: main sends `IOSurfaceCreateMachPort()` in a mach message to a name the **child** checked in with `bootstrap_check_in` (dynamic names are accepted for a non-sandboxed child of Electron), and the child calls `IOSurfaceLookupFromMachPort`. 0.03–0.04 ms in main per frame, against ~2.5 ms for main to lock and copy the surface itself.
- **Windows:** the `ntHandle` (BGRA, `MiscFlags 0x802`, no keyed mutex) is duplicated out of main by the engine (`PROCESS_DUP_HANDLE` + `DuplicateHandle`), opened with `OpenSharedResource1`, copied to a staging texture and mapped. A device on another adapter cannot open it: try the others (two-GPU laptops).
- **Linux (Intel Iris Xe, Mesa, XWayland):** `nativePixmap` is one plane, `modifier "0"` (linear), stride 7680. Imported as an `EGLImage` like `gpu-linux.cpp` does, it **read back as zeros**: `glGetTexImage` returned `GL_NO_ERROR` and an all-black frame, and an FBO on it was `incomplete` — with a 3.3 core context and with or without the explicit LINEAR modifier. An `mmap` of the same fd had the picture. What works: the fds over a `SOCK_SEQPACKET` socket (`SCM_RIGHTS`), `mmap` + `DMA_BUF_IOCTL_SYNC` (`START|READ` … `END|READ`) and a row copy. A non-linear modifier is reported as `ndi-gpu`, never sent as black.
- In every case main keeps the texture until the reader answers `done`, then releases it — never longer (the pool is small).

**Last updated:** 2026-11-09
