#!/usr/bin/env bash
# Builds the media engine for one platform into resources/engine/<platform>-<arch>/ (shipped as
# resources/engine/): media-engine[.exe], handles.node (macOS, Linux) and libmpv where it ships with
# the app.
#   ./native/build.sh darwin-arm64   Xcode command line tools, and our own libmpv for macOS 12+ from
#                                    native/libmpv-mac/build.sh (about 2 minutes). LIBMPV_DIR=/opt/homebrew
#                                    uses Homebrew's instead: this Mac only, it is built for the macOS it
#                                    runs on.
#   ./native/build.sh win32-x64      Docker (mingw-w64). libmpv: the pinned build below, which has the
#                                    D3D11 render API (mpv master, not in any release yet).
#   ./native/build.sh linux-x64      Docker (Debian 12, glibc 2.36). The target uses the system's libmpv.
#   ./native/build.sh pack           Zips every target built here into native/.build/release/, the files of a
#                                    Release `engine-<n>` (see scripts/fetch-binaries.ts), and prints their sha256.
# A build leaves a `.local` marker: scripts/fetch-binaries.ts keeps it instead of the published engine.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=native/.build
if [[ ${1:-} == pack ]]; then
  mkdir -p "$WORK/release"
  for dir in resources/engine/*/; do
    zip=$PWD/$WORK/release/media-engine-$(basename "$dir").zip
    rm -f "$zip"
    # Regular files only: the stamps, and macOS's libmpv.dylib symlink, stay out.
    (cd "$dir" && find . -maxdepth 1 -type f ! -name '.*' ! -name NOTICE.txt | sed 's|^\./||' | sort | zip -X -q "$zip" -@)
    shasum -a 256 "$zip"
  done
  exit
fi
TARGET=${1:?usage: native/build.sh darwin-arm64|win32-x64|linux-x64|pack}
OUT=resources/engine/$TARGET
NODE_INC=$(dirname "$(dirname "$(node -p process.execPath)")")/include/node
FLAGS=(-O2 -std=c++17 -Wall -Wno-missing-field-initializers)
rm -rf "$OUT" && mkdir -p "$OUT" "$WORK"

case $TARGET in
darwin-*)
  LIBMPV_DIR=${LIBMPV_DIR:-native/libmpv-mac/out/dist/libmpv-mac-arm64}
  [[ -d $LIBMPV_DIR ]] || { echo "no libmpv at $LIBMPV_DIR: run native/libmpv-mac/build.sh first"; exit 1; }
  INC=$LIBMPV_DIR/include
  LIB=$LIBMPV_DIR/lib
  [[ -d $LIB ]] || LIB=$LIBMPV_DIR
  # A self-contained libmpv ships next to the engine; Homebrew's is only linked where it is.
  RPATH=@executable_path
  if [[ $LIBMPV_DIR == /opt/homebrew ]]; then
    RPATH=$LIB
    echo "warning: Homebrew's libmpv, so this engine only runs on this Mac (set LIBMPV_DIR for a shippable one)"
  else
    cp -a "$LIB"/*.dylib "$OUT/"
  fi
  clang++ "${FLAGS[@]}" -Wno-multichar -Wno-deprecated-declarations -mmacosx-version-min=12.0 -I "$INC" \
    native/engine/engine.cpp native/engine/gpu-apple.cpp -L "$LIB" -lmpv -Wl,-rpath,"$RPATH" \
    -framework OpenGL -framework IOSurface -framework CoreFoundation -o "$OUT/media-engine"
  clang++ "${FLAGS[@]}" -mmacosx-version-min=12.0 -bundle -undefined dynamic_lookup -I "$NODE_INC" \
    native/handles/handles.cpp -framework IOSurface -framework CoreFoundation -o "$OUT/handles.node"
  ;;
win32-x64)
  # shinchiro's mpv-winbuild-cmake, 2026-10-21 (mpv master e471496c56: the first builds with the D3D11
  # render API). Pinned: a newer one is a decision, tested on Windows before it ships.
  MPV_7Z=mpv-dev-x86_64-20261021-git-e471496c56.7z
  MPV_SHA256=efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633
  if [[ ! -f $WORK/mpv-win/libmpv-2.dll ]]; then
    curl -fsSL --retry 3 -o "$WORK/$MPV_7Z" "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/$MPV_7Z"
    echo "$MPV_SHA256  $WORK/$MPV_7Z" | shasum -a 256 -c -
    mkdir -p "$WORK/mpv-win" && tar -xf "$WORK/$MPV_7Z" -C "$WORK/mpv-win"
  fi
  docker image inspect lumina-mingw >/dev/null 2>&1 ||
    printf 'FROM debian:trixie-slim\nRUN apt-get update && apt-get install -y --no-install-recommends g++-mingw-w64-x86-64-posix && rm -rf /var/lib/apt/lists/*\n' |
    docker build -q -t lumina-mingw -
  docker run --rm -v "$PWD:/w" -w /w lumina-mingw x86_64-w64-mingw32-g++-posix "${FLAGS[@]}" -static -static-libgcc -static-libstdc++ \
    native/engine/engine.cpp native/engine/gpu-windows.cpp -I "$WORK/mpv-win/include" "$WORK/mpv-win/libmpv.dll.a" \
    -ld3d11 -ldxgi -lwinmm -o "$OUT/media-engine.exe"
  cp "$WORK/mpv-win/libmpv-2.dll" "$OUT/"
  ;;
linux-x64)
  mkdir -p "$WORK/node-include" && cp "$NODE_INC"/{node_api.h,node_api_types.h,js_native_api.h,js_native_api_types.h} "$WORK/node-include/"
  docker image inspect lumina-linux-mpv-build >/dev/null 2>&1 ||
    printf 'FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends g++ libmpv-dev libegl-dev libgbm-dev libdrm-dev libgl-dev libopengl-dev && rm -rf /var/lib/apt/lists/*\n' |
    docker build --platform linux/amd64 -q -t lumina-linux-mpv-build -
  docker run --rm --platform linux/amd64 -v "$PWD:/w" -w /w lumina-linux-mpv-build sh -c "
    g++ ${FLAGS[*]} -static-libstdc++ -static-libgcc native/engine/engine.cpp native/engine/gpu-linux.cpp -I /usr/include/libdrm \
      -lmpv -lEGL -lOpenGL -lgbm -o $OUT/media-engine &&
    g++ ${FLAGS[*]} -shared -fPIC -static-libstdc++ -static-libgcc native/handles/handles.cpp -I $WORK/node-include -o $OUT/handles.node"
  ;;
*)
  echo "unknown target $TARGET"
  exit 1
  ;;
esac
touch "$OUT/.local"
ls -la "$OUT"
