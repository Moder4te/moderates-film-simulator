#!/usr/bin/env bash
# RAW 현상부(LibRaw + native/raw/filmsim_raw.cpp)를 WebAssembly로 빌드한다.
#
#   tools/build-raw-wasm.sh            →  apps/studio/vendor/filmsim-raw.wasm
#
# 결과물은 **저장소에 커밋한다.** 그래야 Studio 빌드(tools/build-studio.js)가 노드만으로
# 돈다 — 이 스크립트는 LibRaw 판을 올리거나 현상 인자를 고칠 때만 돌린다.
#
# 필요한 것
#   emscripten   em++ (3.1.6 이상. Ubuntu는 `apt install emscripten`)
#   LibRaw 소스  LIBRAW_SRC=/path/to/LibRaw  — 없으면 아래 태그를 build/LibRaw에 받는다
#
# 빌드 방식
#   -sSTANDALONE_WASM   emscripten의 JS 접착 코드 없이 .wasm 하나만 낸다. 불러오는 쪽
#                       (core/io/rawdecoder.js)이 수십 줄이고, 노드·브라우저·WebView에서
#                       같은 코드로 뜬다
#   -fwasm-exceptions   LibRaw는 오류를 C++ 예외로 던진다. JS 접착 없이 예외를 쓰려면
#                       WebAssembly 자체 예외여야 한다(Chrome 95 · Firefox 100 · Safari 15.2 · Node 17 이상)
#   LIBRAW_NOTHREADS    스레드 없음. 워커 하나에서 한 장씩 푼다
#   zlib 없음           Deflate로 압축한 DNG는 못 연다(무압축·무손실 JPEG DNG는 된다).
#                       손실 JPEG·JPEG XL DNG도 같다 — libjpeg·libjxl을 넣지 않았다
set -euo pipefail

LIBRAW_TAG=0.22.2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/studio/vendor/filmsim-raw.wasm"
BUILD="$ROOT/build/raw-wasm"
SRC="${LIBRAW_SRC:-$ROOT/build/LibRaw}"

command -v em++ > /dev/null || { echo "em++가 없습니다 — emscripten을 설치하세요" >&2; exit 1; }
if [ ! -d "$SRC/src" ]; then
  git clone --depth 1 --branch "$LIBRAW_TAG" https://github.com/LibRaw/LibRaw.git "$SRC"
fi
grep -q "LIBRAW_MINOR_VERSION 22" "$SRC/libraw/libraw_version.h" || echo "⚠️ LibRaw 판이 $LIBRAW_TAG 와 다릅니다" >&2

mkdir -p "$BUILD" "$(dirname "$OUT")"
export SRC BUILD
export FLAGS="-O2 -fwasm-exceptions -DLIBRAW_NOTHREADS -I$SRC -w"

# LibRaw 공식 Makefile.dist의 LIB_OBJECTS와 같은 목록 — *_ph.cpp는 다른 파일이
# #include하는 조각이라 따로 컴파일하지 않는다. 고친 파일만 다시 컴파일한다
find "$SRC/src" -name '*.cpp' ! -name '*_ph.cpp' -print0 | xargs -0 -P "$(nproc)" -I{} bash -c '
  f="$1"; o="$BUILD/$(echo "${f#$SRC/}" | tr / _).o"
  if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then em++ $FLAGS -c "$f" -o "$o"; fi' _ {}

EXPORTS='["_malloc","_free","_fs_raw_decode","_fs_raw_width","_fs_raw_height","_fs_raw_pixels","_fs_raw_baseline_exposure","_fs_raw_is_dng","_fs_raw_is_half","_fs_raw_make","_fs_raw_model","_fs_raw_error","_fs_raw_version","_fs_raw_release"]'
em++ $FLAGS "$ROOT/native/raw/filmsim_raw.cpp" "$BUILD"/*.o -o "$OUT" \
  -sSTANDALONE_WASM --no-entry \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4GB \
  -sEXPORTED_FUNCTIONS="$EXPORTS"

ls -la "$OUT"
