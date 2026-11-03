## A Linux engine built on Debian 12 needs glibc 2.36, and libmpv does not bring libOpenGL
**Area:** build
**Trigger:** changing the Linux build of `native/` (`native/build.sh linux-x64`), the `.deb`'s `depends`, or a report that the engine does not start on Ubuntu 22.04 or on a minimal install

- The plan said Ubuntu 22.04 only needed `libmpv.so.1`. It also needed an older glibc: built on
  Debian 12, `media-engine` and `handles.node` import `arc4random@GLIBC_2.36` from the static
  libstdc++ (`objdump -T`), and Ubuntu 22.04 has 2.35, so the loader refuses it before libmpv
  matters. Built on Ubuntu 22.04 the newest symbol is `GLIBC_2.34`.
- The two sonames (`.so.1` = mpv 0.34, `.so.2` = 0.35+) differ only in APIs the engine never calls,
  so the engine links no libmpv and `native/engine/mpv-linux.cpp` forwards each `mpv_*` it uses to
  whichever `dlopen` finds. A new `mpv_*` call fails to link until it is added there.
- `apt install libmpv1`/`libmpv2` in a clean container does NOT install `libOpenGL.so.0`, which the
  engine links (`-lOpenGL`): `error while loading shared libraries: libOpenGL.so.0`. Hence
  `libopengl0` in the `.deb`'s `depends`, next to `libmpv2 | libmpv1`. Setting `deb.depends`
  replaces electron-builder's defaults, which is why they are spelled out in `package.json`.
- Checked 2026-11-03: the `.deb` installs with `apt` and its engine loads mpv 0.34 (Ubuntu 22.04),
  0.35 (Debian 12) and 0.37 (Ubuntu 24.04), stopping at `engine-gpu` (Docker has no
  `/dev/dri`). Playback itself needs a real PC.

**Last updated:** 2026-11-03
