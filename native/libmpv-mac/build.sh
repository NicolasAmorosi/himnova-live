#!/bin/zsh
# Builds a self-contained libmpv 0.41.0 for macOS arm64, minimum macOS 12.0: a single libmpv.2.dylib with
# FFmpeg (decoding only), libplacebo, libass, harfbuzz, freetype and fribidi linked in statically. It only
# links system frameworks and /usr/lib. Nothing is installed system-wide: meson/ninja live in a venv, pkgconf
# is built from source, everything else under out/.
#   ./build.sh         build (re-runnable: each finished step leaves a stamp in out/stamps and is skipped;
#                      delete a stamp to rebuild that step)
#   ./build.sh clean   wipe everything in out/ except the downloads
# Result: out/dist/libmpv-mac-arm64/ (libmpv.2.dylib, libmpv.dylib -> it, include/mpv/*.h) and
# out/libmpv-mac-arm64-0.41.0.tar.gz. Needs Xcode's command line tools and network for the first run.
set -euo pipefail
cd "${0:A:h}"
OUT=$PWD/out
DL=$OUT/dl SRC=$OUT/src BUILD=$OUT/build PREFIX=$OUT/prefix TOOLS=$OUT/tools STAMPS=$OUT/stamps
NAME=libmpv-mac-arm64 DIST=$OUT/dist/libmpv-mac-arm64 TARBALL=$OUT/libmpv-mac-arm64-0.41.0.tar.gz
MIN=12.0
JOBS=$(sysctl -n hw.ncpu)

if [[ ${1:-} == clean ]]; then rm -rf $SRC $BUILD $PREFIX $TOOLS $OUT/venv $STAMPS $OUT/dist $TARBALL; exit; fi
[[ $(uname -m) == arm64 ]] || { echo "run this natively on Apple silicon"; exit 1; }

# name, file, sha256, url. The libplacebo 3rdparty trees are the commits its submodules pin in v7.360.1:
# fast_float because libc++ has no floating-point std::from_chars before macOS 26, Vulkan-Headers because
# its Vulkan stubs include vulkan.h even with Vulkan disabled.
SOURCES=(
  pkgconf    pkgconf-2.5.1.tar.xz       cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243 https://distfiles.ariadne.space/pkgconf/pkgconf-2.5.1.tar.xz
  fribidi    fribidi-1.0.17.tar.xz      6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2 https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz
  freetype   freetype-2.14.3.tar.xz     36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz
  harfbuzz   harfbuzz-14.6.0.tar.xz     d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586 https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz
  libass     libass-0.17.5.tar.xz       2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz
  ffmpeg     ffmpeg-8.0.3.tar.xz        6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818 https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz
  libplacebo libplacebo-7.360.1.tar.gz  d05fdf90bea2f629eaa2d115e909fd356388ac639e54f77b87a018a6d76224bd https://github.com/haasn/libplacebo/archive/refs/tags/v7.360.1.tar.gz
  fast_float fast_float-97b54ca9.tar.gz 2b132274539286e41f37857cac22aa8441d21bd86d55de825a3342b149f66801 https://github.com/fastfloat/fast_float/archive/97b54ca9e75f5303507699d27c6b4f4efe4641a1.tar.gz
  glad       glad-73db193f.tar.gz       33dbeae44d8315ece57e14eba4b1b4a02ac5406d1c4f49cd20048c91522a6b9a https://github.com/Dav1dde/glad/archive/73db193f853e2ee079bf3ca8a64aa2eaf6459043.tar.gz
  jinja      jinja-15206881.tar.gz      b88a20dcc2e34072fcf4159325bc6c34cd4b29a81a8b83d15d2f28ba561da296 https://github.com/pallets/jinja/archive/15206881c006c79667fe5154fe80c01c65410679.tar.gz
  markupsafe markupsafe-297fc8e3.tar.gz da7c010c9c81a66ac73036558c1fcb6212b50482f43211cd1254035b94f82414 https://github.com/pallets/markupsafe/archive/297fc8e356e6836a62087949245d09a28e9f1b13.tar.gz
  Vulkan-Headers vulkan-headers-450bd223.tar.gz 26df9841c30806a994e2fdf42f7c87bcb1ced9db9a06033469123939fb3fa075 https://github.com/KhronosGroup/Vulkan-Headers/archive/450bd2232225d6c7728a4108055ac2e37cef6475.tar.gz
  mpv        mpv-0.41.0.tar.gz         ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209 https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz
)
# Build tools from PyPI, hash-pinned, for the system Python 3.9 (meson 1.12 needs 3.10; ninja: the universal2 wheel).
PY_REQUIREMENTS='
meson==1.11.2 --hash=sha256:7e4f6e83fec83e3eaac928e058b073c7557b282c35b6a2024cea143a39926a39
ninja==1.13.2 --hash=sha256:fd82e26c0706ad4ab88e5fdd26f3fab0a987a90f810160f6c322e752c6af298b
'

# Only the system's tools and ours: nothing from Homebrew or /usr/local can leak in.
export PATH=$OUT/venv/bin:$TOOLS/bin:/usr/bin:/bin:/usr/sbin:/sbin
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH PKG_CONFIG_PATH DYLD_LIBRARY_PATH
export PKG_CONFIG=$TOOLS/bin/pkg-config PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig
export MACOSX_DEPLOYMENT_TARGET=$MIN CC=clang CXX=clang++ OBJC=clang
export CFLAGS=-mmacosx-version-min=$MIN CXXFLAGS=-mmacosx-version-min=$MIN OBJCFLAGS=-mmacosx-version-min=$MIN
export LDFLAGS=-mmacosx-version-min=$MIN
MESON=(--prefix=$PREFIX --libdir=lib --buildtype=release --default-library=static --prefer-static
  --wrap-mode=nofallback -Dauto_features=disabled)

src() { # <name> [dir]: a fresh, verified source tree of <name> in $SRC/<name> (or dir)
  local i=${SOURCES[(i)$1]}
  local file=${SOURCES[i+1]} sum=${SOURCES[i+2]} url=${SOURCES[i+3]} dir=${2:-$SRC/$1}
  mkdir -p $DL
  if ! echo "$sum  $DL/$file" | shasum -a 256 -c --status 2>/dev/null; then
    curl -fL --retry 3 -o $DL/$file.part $url && mv $DL/$file.part $DL/$file
    echo "$sum  $DL/$file" | shasum -a 256 -c --status || { echo "sha256 mismatch: $file"; shasum -a 256 $DL/$file; exit 1; }
  fi
  rm -rf $dir && mkdir -p $dir && tar -xf $DL/$file -C $dir --strip-components 1
}

meson_build() { # <name> [meson -D options...]
  rm -rf $BUILD/$1
  meson setup $BUILD/$1 $SRC/$1 $MESON "${@:2}"
  meson compile -C $BUILD/$1 -j $JOBS
  meson install -C $BUILD/$1 --quiet
}

step() { # <name>: runs build_<name> once
  [[ -f $STAMPS/$1 ]] && { echo "== $1: already built"; return; }
  echo "== $1"
  local t=$SECONDS
  build_$1
  mkdir -p $STAMPS && touch $STAMPS/$1
  echo "== $1: $((SECONDS - t)) s"
}

build_venv() {
  rm -rf $OUT/venv
  /usr/bin/python3 -m venv $OUT/venv
  pip install --disable-pip-version-check --no-deps --only-binary :all: --require-hashes -r =(print -r -- $PY_REQUIREMENTS)
}

build_pkgconf() {
  src pkgconf
  rm -rf $BUILD/pkgconf && mkdir -p $BUILD/pkgconf && cd $BUILD/pkgconf
  $SRC/pkgconf/configure --prefix=$TOOLS --disable-shared --enable-static
  make -j $JOBS && make install
  ln -sf pkgconf $TOOLS/bin/pkg-config
  cd $OLDPWD
}

build_fribidi() {
  src fribidi
  meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
}

# No zlib/bzip2/png/brotli/harfbuzz: libass only feeds it the system's TrueType/OpenType fonts.
build_freetype() {
  src freetype
  meson_build freetype -Dzlib=disabled -Dharfbuzz=disabled -Dmmap=enabled
}

build_harfbuzz() {
  src harfbuzz
  meson_build harfbuzz -Dfreetype=enabled -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dsubset=disabled \
    -Dtests=disabled -Dutilities=disabled
}

# Core Text finds the fonts, no fontconfig.
build_libass() {
  src libass
  meson_build libass -Dcoretext=enabled -Dasm=enabled
}

# Decoding only: every decoder, demuxer, parser, bitstream filter and filter, VideoToolbox hwaccels;
# no encoders, muxers, devices, network or external libraries but the system's zlib and iconv.
build_ffmpeg() {
  src ffmpeg
  rm -rf $BUILD/ffmpeg && mkdir -p $BUILD/ffmpeg && cd $BUILD/ffmpeg
  $SRC/ffmpeg/configure --prefix=$PREFIX --cc=clang --cxx=clang++ --objcc=clang \
    --extra-cflags=-mmacosx-version-min=$MIN --extra-objcflags=-mmacosx-version-min=$MIN \
    --extra-ldflags=-mmacosx-version-min=$MIN \
    --enable-static --disable-shared --disable-programs --disable-doc --disable-debug \
    --disable-autodetect --enable-pthreads --enable-videotoolbox --enable-zlib --enable-iconv \
    --disable-avdevice --disable-encoders --disable-muxers --disable-devices --disable-network
  make -j $JOBS && make install
  cd $OLDPWD
}

# OpenGL only (no Vulkan, no shader compilers, no lcms); mpv hands it the GL function loader.
build_libplacebo() {
  src libplacebo
  local d
  for d in fast_float glad jinja markupsafe Vulkan-Headers; do src $d $SRC/libplacebo/3rdparty/$d; done
  meson_build libplacebo -Dopengl=enabled -Ddovi=enabled -Ddemos=false
}

# libmpv only, with the OpenGL render API on Cocoa, VideoToolbox + GL interop, Core Audio and AVFoundation
# audio. Only the mpv_* API is exported, so the static libraries inside stay private and dead code goes.
# mpv's meson links with b_lundef=false (-undefined dynamic_lookup), which hides missing symbols until they
# crash at runtime; b_lundef=true makes them link errors, and these close the gaps it showed:
# -liconv: with --prefer-static meson looks for a libiconv.a the SDK doesn't have; this links the system one.
# -lc++: libplacebo is partly C++ and its static .pc doesn't say so. IOSurface: hwdec_mac_gl.c uses it.
# The patch: Cocoa without Swift is allowed for libmpv but broken in 0.41: the clipboard backend is a Swift
# class, and the player calls Swift-only hooks and opens a "mac" client that only Swift initializes (playback
# waits for it forever). All of that now happens only with Swift.
build_mpv() {
  src mpv
  patch -p1 -d $SRC/mpv <<'PATCH'
--- a/meson.build
+++ b/meson.build
@@ -416,8 +416,7 @@
     path_source += files('osdep/path-mac.m')
     sources += files('osdep/language-mac.c',
                      'osdep/utils-mac.c',
-                     'osdep/mac/app_bridge.m',
-                     'player/clipboard/clipboard-mac.m')
+                     'osdep/mac/app_bridge.m')
     main_fn_source = files('osdep/main-fn-mac.c')
 endif

@@ -1582,6 +1581,7 @@

 swift_sources = []
 if features['cocoa'] and features['swift']
+    sources += files('player/clipboard/clipboard-mac.m')
     swift_sources += files('osdep/mac/application.swift',
                            'osdep/mac/app_hub.swift',
                            'osdep/mac/clipboard.swift',
--- a/player/clipboard/clipboard.c
+++ b/player/clipboard/clipboard.c
@@ -39,7 +39,7 @@
 #if HAVE_WIN32_DESKTOP
     &clipboard_backend_win32,
 #endif
-#if HAVE_COCOA
+#if HAVE_SWIFT
     &clipboard_backend_mac,
 #endif
 #if HAVE_WAYLAND && HAVE_WAYLAND_PROTOCOLS_1_39
--- a/input/input.c
+++ b/input/input.c
@@ -1700,7 +1700,7 @@
 {
     m_config_cache_update(ictx->opts_cache);
 
-#if HAVE_COCOA
+#if HAVE_SWIFT
     struct input_opts *opts = ictx->opts;
 
     if (ictx->using_cocoa_media_keys != (opts->use_media_keys && !shutdown)) {
--- a/player/main.c
+++ b/player/main.c
@@ -192,7 +192,7 @@
 
     osd_free(mpctx->osd);
 
-#if HAVE_COCOA
+#if HAVE_SWIFT
     cocoa_set_input_context(NULL);
 #endif
 
@@ -314,7 +314,7 @@
     mp_clients_init(mpctx);
     mpctx->osd = osd_create(mpctx->global);
 
-#if HAVE_COCOA
+#if HAVE_SWIFT
     cocoa_set_input_context(mpctx->input);
 #endif
 
@@ -409,7 +409,7 @@
 
     MP_STATS(mpctx, "start init");
 
-#if HAVE_COCOA
+#if HAVE_SWIFT
     mpv_handle *ctx = mp_new_client(mpctx->clients, "mac");
     cocoa_set_mpv_handle(ctx);
 #endif
PATCH
  local link="['-mmacosx-version-min=$MIN', '-Wl,-dead_strip', '-Wl,-exported_symbol,_mpv_*', '-liconv', '-lc++', '-Wl,-framework,IOSurface']"
  meson_build mpv --default-library=shared -Db_lundef=true -Dlibmpv=true -Dcplayer=false -Dtests=false -Dbuild-date=false \
    -Dlua=disabled -Dgl=enabled -Dcocoa=enabled -Dgl-cocoa=enabled -Dvideotoolbox-gl=enabled \
    -Dcoreaudio=enabled -Davfoundation=enabled -Diconv=enabled -Dzlib=enabled -Dvector=enabled \
    -Dmacos-10-15-4-features=enabled -Dmacos-11-features=enabled -Dmacos-11-3-features=enabled \
    -Dmacos-12-features=enabled -Dc_link_args=$link -Dobjc_link_args=$link
}

step venv
step pkgconf
step fribidi
step freetype
step harfbuzz
step libass
step ffmpeg
step libplacebo
step mpv

echo "== dist"
rm -rf $DIST $TARBALL && mkdir -p $DIST/include
cp -R $PREFIX/include/mpv $DIST/include/
cp $PREFIX/lib/libmpv.2.dylib $DIST/
ln -s libmpv.2.dylib $DIST/libmpv.dylib
LIB=$DIST/libmpv.2.dylib
install_name_tool -id @rpath/libmpv.2.dylib $LIB
strip -x $LIB
codesign -f -s - $LIB

# Checks: arm64, minos 12.0 in the dylib and in every object of the static libraries folded into it,
# nothing linked but @rpath, /usr/lib and system frameworks, no symbol left to dynamic lookup (it would be
# NULL at runtime) and no weak imports: those are APIs newer than macOS 12; there are none today, so a new one
# needs a look (it must sit behind an availability check).
fail() { echo "CHECK FAILED: $*"; exit 1; }
[[ $(lipo -archs $LIB) == arm64 ]] || fail "architectures: $(lipo -archs $LIB)"
minos=$(otool -l $LIB | awk '/LC_BUILD_VERSION/ {b = 1} b && /minos/ {print $2; exit}')
[[ $minos == $MIN ]] || fail "minos $minos"
objs=$(otool -l $PREFIX/lib/*.a | awk '/minos/ {print $2}' | sort | uniq -c)
[[ $(print -r -- $objs | awk '{print $2}' | sort -u) == $MIN ]] || fail "static objects minos: $objs"
bad=$(otool -L $LIB | tail -n +2 | awk '{print $1}' | grep -vE '^(@rpath/|/usr/lib/|/System/Library/)' || true)
[[ -z $bad ]] || fail "links outside the system: $bad"
nm -m $LIB | grep -E 'dynamically looked up|undefined\) weak' && fail "unresolved or weak imports above"

tar -czf $TARBALL -C $OUT/dist $NAME
echo
otool -L $LIB
echo "minos $minos (static objects: $(print -r -- $objs | xargs))"
ls -lR $DIST
shasum -a 256 $TARBALL
