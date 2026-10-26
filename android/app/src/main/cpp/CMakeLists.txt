# RAW 현상(LibRaw) + LUT 적용 네이티브 라이브러리.
#
# LibRaw 소스는 저장소에 두지 않고 빌드 때 받는다(태그 고정). 미리 받아 둔 소스를 쓰려면
#   -DFETCHCONTENT_SOURCE_DIR_LIBRAW=/path/to/LibRaw
# 안드로이드가 아닌 곳에서 configure하면 검증 도구 filmsim-raw-cli를 만든다
# (tools/check-raw-native.py).
#
# LibRaw는 LGPL 2.1 / CDDL 1.0 이중 라이선스다 — 이 앱은 CDDL 조건으로 쓴다.

cmake_minimum_required(VERSION 3.22.1)
project(filmsim_raw CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)
FetchContent_Declare(
  libraw
  GIT_REPOSITORY https://github.com/LibRaw/LibRaw.git
  GIT_TAG 0.22.2
  GIT_SHALLOW TRUE
)
# LibRaw 저장소 최상위에는 CMakeLists.txt가 없어 MakeAvailable은 소스만 받는다.
FetchContent_MakeAvailable(libraw)

# LibRaw 공식 Makefile.dist의 LIB_OBJECTS와 같은 목록이다. *_ph.cpp는 다른 파일이
# #include하는 조각이라 따로 컴파일하지 않는다.
file(GLOB_RECURSE LIBRAW_SOURCES CONFIGURE_DEPENDS "${libraw_SOURCE_DIR}/src/*.cpp")
list(FILTER LIBRAW_SOURCES EXCLUDE REGEX "_ph\\.cpp$")

find_package(ZLIB REQUIRED)

add_library(raw STATIC ${LIBRAW_SOURCES})
target_include_directories(raw PUBLIC "${libraw_SOURCE_DIR}")
target_compile_definitions(raw PUBLIC LIBRAW_NOTHREADS USE_ZLIB)
target_compile_options(raw PRIVATE -w -O3)
target_link_libraries(raw PUBLIC ZLIB::ZLIB)

add_library(filmsim_core STATIC filmsim_raw.cpp)
target_link_libraries(filmsim_core PUBLIC raw)
target_compile_options(filmsim_core PRIVATE -O3)

if(ANDROID)
  add_library(filmsim_raw SHARED jni.cpp)
  target_link_libraries(filmsim_raw PRIVATE filmsim_core jnigraphics log)
  # 16KB 페이지 기기(Android 15+) 대응
  target_link_options(filmsim_raw PRIVATE "-Wl,-z,max-page-size=16384")
else()
  add_executable(filmsim-raw-cli raw_cli.cpp)
  target_link_libraries(filmsim-raw-cli PRIVATE filmsim_core)
endif()
