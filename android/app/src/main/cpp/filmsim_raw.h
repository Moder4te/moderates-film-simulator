// RAW → 엔진 입력. tools/decode-raw.py의 `load_linear` + 인코딩을 C++로 옮긴 것이다.
//
// JNI(jni.cpp)와 호스트 검증 도구(raw_cli.cpp)가 이 한 벌을 같이 쓴다 — 현상 인자를
// 두 곳에 따로 두면 폰과 검증이 조용히 다른 수를 낸다(decode-raw.py가
// `load_linear`를 GUI와 공유하는 것과 같은 이유).

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace filmsim {

struct RawImage {
    int width = 0;
    int height = 0;
    // ProPhoto(ROMM) 원색 · γ1.8 인코딩 · 화이트 레벨 기준 선형을 인코딩한 값, RGB 16bit.
    // decode-raw.py가 `--midgray` 없이 쓰는 TIFF와 같은 수다. 엔진은 이것을
    // 「리니어 +N스톱」 입력으로 읽는다(core/color/inputs.js linearInput).
    std::vector<uint16_t> pixels;

    int previewWidth = 0;
    int previewHeight = 0;
    std::vector<uint16_t> preview; // 같은 인코딩, 긴 변을 줄인 것

    float baselineExposure = 0;    // DNG BaselineExposure (없으면 0)
    bool dng = false;
    std::string make;
    std::string model;
    double clippedPercent = 0;     // 화이트 레벨에 닿은 화소 비율(어느 채널이든)
};

struct DecodeOptions {
    bool halfSize = false;   // 디모자이크 없이 2×2를 한 화소로 — 빠르고 메모리 1/4
    int previewEdge = 1600;  // 미리보기 긴 변(px). 0이면 미리보기를 만들지 않는다
    bool applyOrientation = true; // EXIF 방향대로 돌린다. 색에는 영향 없다
};

/** 실패하면 false, err에 사유. */
bool decodeRaw(const char* path, const DecodeOptions& opt, RawImage& out, std::string& err);

/** 선형(0~1) → ProPhoto γ1.8. decode-raw.py `encode_prophoto`와 같다(발끝 직선부 포함). */
double encodeProPhoto(double lin);

/**
 * 엔진이 합성한 3D LUT(.cube 순서, size³×3, 출력 sRGB 0~1)을 16bit RGB에 걸어
 * RGBA 8bit로 쓴다. 보간은 core/color/lut.js `sample`과 같은 사면체다.
 */
void applyLut(const uint16_t* rgb16, size_t pixelCount, const float* lut, int size, uint8_t* rgba8);

} // namespace filmsim
