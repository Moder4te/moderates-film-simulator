// 호스트(PC)용 검증 도구. 폰과 같은 filmsim_raw.cpp로 RAW를 현상해 원시 16bit RGB로 쓴다.
// tools/check-raw-native.py가 이 출력을 rawpy(decode-raw.py 경로)와 대조한다.
//
//   filmsim-raw-cli in.NEF out.rgb16 [--half]          → stdout에 JSON 정보
//   filmsim-raw-cli --lut lut.f32 size in.rgb16 out.rgba  → LUT 적용 검사용

#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "filmsim_raw.h"

static bool readAll(const char* path, std::vector<char>& buf) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    buf.assign(std::istreambuf_iterator<char>(f), {});
    return true;
}

int main(int argc, char** argv) {
    if (argc >= 6 && std::strcmp(argv[1], "--lut") == 0) {
        std::vector<char> lut, src;
        if (!readAll(argv[2], lut) || !readAll(argv[4], src)) return 2;
        int size = std::atoi(argv[3]);
        size_t n = src.size() / 6;
        std::vector<uint8_t> out(n * 4);
        filmsim::applyLut(reinterpret_cast<const uint16_t*>(src.data()), n, reinterpret_cast<const float*>(lut.data()),
                          size, out.data());
        std::ofstream(argv[5], std::ios::binary).write(reinterpret_cast<const char*>(out.data()), out.size());
        return 0;
    }
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s in.raw out.rgb16 [--half]\n", argv[0]);
        return 2;
    }
    filmsim::DecodeOptions opt;
    opt.halfSize = argc > 3 && std::strcmp(argv[3], "--half") == 0;
    opt.applyOrientation = false; // decode-raw.py(user_flip=0)와 화소 위치까지 맞춘다
    filmsim::RawImage img;
    std::string err;
    if (!filmsim::decodeRaw(argv[1], opt, img, err)) {
        std::fprintf(stderr, "%s\n", err.c_str());
        return 1;
    }
    std::ofstream(argv[2], std::ios::binary)
        .write(reinterpret_cast<const char*>(img.pixels.data()), img.pixels.size() * 2);
    std::printf("{\"width\":%d,\"height\":%d,\"previewWidth\":%d,\"previewHeight\":%d,\"baselineExposure\":%g,"
                "\"clippedPercent\":%g,\"make\":\"%s\",\"model\":\"%s\"}\n",
                img.width, img.height, img.previewWidth, img.previewHeight, img.baselineExposure,
                img.clippedPercent, img.make.c_str(), img.model.c_str());
    return 0;
}
