#include "filmsim_raw.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>

#include "libraw/libraw.h"

namespace filmsim {

double encodeProPhoto(double lin) {
    // decode-raw.py: np.where(lin < 0.001953125, lin * 16, lin ** (1/1.8)) 뒤 0~1 클립
    double v = lin < 0.001953125 ? lin * 16.0 : std::pow(lin < 0 ? 0.0 : lin, 1.0 / 1.8);
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

namespace {

/** 16bit 선형 → 16bit 인코딩 표. np.rint(enc * 65535)와 같게 반올림한다(짝수 반올림). */
const std::vector<uint16_t>& encodeTable() {
    static const std::vector<uint16_t> table = [] {
        std::vector<uint16_t> t(65536);
        for (int i = 0; i < 65536; i++) {
            t[i] = static_cast<uint16_t>(std::nearbyint(encodeProPhoto(i / 65535.0) * 65535.0));
        }
        return t;
    }();
    return table;
}

/**
 * 긴 변을 maxEdge로 줄인다. **선형에서** 상자 평균한다 — 인코딩된 값을 평균하면
 * 밝은 점이 어두워진다(γ 공간 평균). 결과는 인코딩해서 돌려준다.
 */
void makePreview(const uint16_t* lin, int w, int h, int maxEdge, RawImage& out) {
    const auto& enc = encodeTable();
    int edge = std::max(w, h);
    int f = edge > maxEdge ? (edge + maxEdge - 1) / maxEdge : 1; // 정수 배율 — 상자가 겹치지 않는다
    int pw = w / f;
    int ph = h / f;
    out.previewWidth = pw;
    out.previewHeight = ph;
    out.preview.assign(static_cast<size_t>(pw) * ph * 3, 0);
    const double inv = 1.0 / (f * f);
    for (int y = 0; y < ph; y++) {
        for (int x = 0; x < pw; x++) {
            double acc[3] = {0, 0, 0};
            for (int dy = 0; dy < f; dy++) {
                const uint16_t* row = lin + (static_cast<size_t>(y * f + dy) * w + x * f) * 3;
                for (int dx = 0; dx < f; dx++) {
                    acc[0] += row[dx * 3];
                    acc[1] += row[dx * 3 + 1];
                    acc[2] += row[dx * 3 + 2];
                }
            }
            uint16_t* o = &out.preview[(static_cast<size_t>(y) * pw + x) * 3];
            for (int c = 0; c < 3; c++) {
                o[c] = enc[static_cast<int>(acc[c] * inv + 0.5)];
            }
        }
    }
}

struct MemImageDeleter {
    void operator()(libraw_processed_image_t* p) const { LibRaw::dcraw_clear_mem(p); }
};

} // namespace

bool decodeRaw(const char* path, const DecodeOptions& opt, RawImage& out, std::string& err) {
    // LibRaw 객체는 수백 KB라 스택에 두지 않는다.
    auto raw = std::make_unique<LibRaw>();
    auto& p = raw->imgdata.params;

    // ── decode-raw.py `load_linear`의 rawpy.postprocess 인자와 같게 ─────────
    p.use_camera_wb = 1;   // use_camera_wb=True
    p.no_auto_bright = 1;  // 자동 밝기 = 씬마다 다른 톤. 절대 켜지 않는다
    p.gamm[0] = 1.0;       // gamma=(1, 1) — **선형**
    p.gamm[1] = 1.0;
    p.output_color = 4;    // ProPhoto
    p.output_bps = 16;
    // decode-raw.py는 user_flip=0(회전 안 함)이다. 폰에서는 보이는 방향이 맞아야 해서
    // 기본은 EXIF대로 돌린다. 화소 값은 그대로라 색 결과는 같다.
    p.user_flip = opt.applyOrientation ? -1 : 0;
    p.half_size = opt.halfSize ? 1 : 0;

    int rc = raw->open_file(path);
    if (rc != LIBRAW_SUCCESS) {
        err = std::string("RAW로 열 수 없다: ") + libraw_strerror(rc);
        return false;
    }
    out.make = raw->imgdata.idata.make;
    out.model = raw->imgdata.idata.model;
    out.dng = raw->imgdata.idata.dng_version != 0;
    out.baselineExposure = out.dng ? raw->imgdata.color.dng_levels.baseline_exposure : 0.0f;
    if (!std::isfinite(out.baselineExposure) || out.baselineExposure < -8 || out.baselineExposure > 8) {
        out.baselineExposure = 0;
    }

    rc = raw->unpack();
    if (rc != LIBRAW_SUCCESS) {
        err = std::string("RAW 데이터를 못 풀었다: ") + libraw_strerror(rc);
        if (out.dng) err += " (JPEG XL로 압축한 DNG는 지원하지 않는다 — 카메라 설정에서 RAW 압축을 끄거나 무손실로)";
        return false;
    }
    rc = raw->dcraw_process();
    if (rc != LIBRAW_SUCCESS) {
        err = std::string("현상 실패: ") + libraw_strerror(rc);
        return false;
    }

    int memErr = 0;
    std::unique_ptr<libraw_processed_image_t, MemImageDeleter> img(raw->dcraw_make_mem_image(&memErr));
    if (!img) {
        err = std::string("현상 결과를 못 만들었다: ") + libraw_strerror(memErr);
        return false;
    }
    raw->recycle(); // 디모자이크 버퍼를 먼저 놓는다 — 큰 RAW에서 메모리 정점을 낮춘다

    if (img->type != LIBRAW_IMAGE_BITMAP || img->colors != 3 || img->bits != 16) {
        err = "예상하지 못한 현상 결과 형식";
        return false;
    }
    out.width = img->width;
    out.height = img->height;
    const size_t n = static_cast<size_t>(out.width) * out.height * 3;
    out.pixels.resize(n);
    std::memcpy(out.pixels.data(), img->data, n * sizeof(uint16_t));
    img.reset();

    if (opt.previewEdge > 0) makePreview(out.pixels.data(), out.width, out.height, opt.previewEdge, out);

    // 잘림 집계 후 제자리 인코딩
    const auto& enc = encodeTable();
    size_t clipped = 0;
    uint16_t* px = out.pixels.data();
    for (size_t i = 0; i < n; i += 3) {
        if (px[i] == 65535 || px[i + 1] == 65535 || px[i + 2] == 65535) clipped++;
        px[i] = enc[px[i]];
        px[i + 1] = enc[px[i + 1]];
        px[i + 2] = enc[px[i + 2]];
    }
    out.clippedPercent = n ? 100.0 * clipped / (n / 3) : 0;
    return true;
}

namespace {

/** core/color/lut.js `sample`을 그대로 옮긴 것. 분기·가중치 순서까지 같다. */
inline void sample(const float* lut, int size, float r, float g, float b, float* out) {
    const int d = size - 1;
    const float x = r * d, y = g * d, z = b * d;
    int i = static_cast<int>(x), j = static_cast<int>(y), k = static_cast<int>(z);
    if (i >= d) i = d - 1;
    if (j >= d) j = d - 1;
    if (k >= d) k = d - 1;
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (k < 0) k = 0;
    const float fr = x - i, fg = y - j, fb = z - k;

    const int s1 = 3, s2 = size * 3, s3 = size * size * 3;
    const float* c000 = lut + (static_cast<size_t>(k) * size * size + j * size + i) * 3;
    const float* c100 = c000 + s1;
    const float* c010 = c000 + s2;
    const float* c001 = c000 + s3;
    const float* c110 = c000 + s1 + s2;
    const float* c101 = c000 + s1 + s3;
    const float* c011 = c000 + s2 + s3;
    const float* c111 = c000 + s1 + s2 + s3;

    for (int c = 0; c < 3; c++) {
        if (fr > fg) {
            if (fg > fb) {
                out[c] = c000[c] + (c100[c] - c000[c]) * fr + (c110[c] - c100[c]) * fg + (c111[c] - c110[c]) * fb;
            } else if (fr > fb) {
                out[c] = c000[c] + (c100[c] - c000[c]) * fr + (c111[c] - c101[c]) * fg + (c101[c] - c100[c]) * fb;
            } else {
                out[c] = c000[c] + (c101[c] - c001[c]) * fr + (c111[c] - c101[c]) * fg + (c001[c] - c000[c]) * fb;
            }
        } else if (fb > fg) {
            out[c] = c000[c] + (c111[c] - c011[c]) * fr + (c011[c] - c001[c]) * fg + (c001[c] - c000[c]) * fb;
        } else if (fb > fr) {
            out[c] = c000[c] + (c111[c] - c011[c]) * fr + (c010[c] - c000[c]) * fg + (c011[c] - c010[c]) * fb;
        } else {
            out[c] = c000[c] + (c110[c] - c010[c]) * fr + (c010[c] - c000[c]) * fg + (c111[c] - c110[c]) * fb;
        }
    }
}

inline uint8_t to8(float v) {
    // 반올림한다 — 정수 버퍼로 나가는 자리의 규약(docs/ARCHITECTURE.md 양자화 규약)
    float s = v * 255.0f;
    return s <= 0 ? 0 : s >= 255 ? 255 : static_cast<uint8_t>(s + 0.5f);
}

} // namespace

void applyLut(const uint16_t* rgb16, size_t pixelCount, const float* lut, int size, uint8_t* rgba8) {
    const float inv = 1.0f / 65535.0f;
    float o[3];
    for (size_t p = 0; p < pixelCount; p++) {
        const uint16_t* s = rgb16 + p * 3;
        sample(lut, size, s[0] * inv, s[1] * inv, s[2] * inv, o);
        uint8_t* d = rgba8 + p * 4;
        d[0] = to8(o[0]);
        d[1] = to8(o[1]);
        d[2] = to8(o[2]);
        d[3] = 255;
    }
}

} // namespace filmsim
