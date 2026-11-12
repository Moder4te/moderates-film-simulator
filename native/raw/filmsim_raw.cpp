// RAW → 선형 ProPhoto 16bit. **플랫 현상** — 톤 커브가 하나도 없다.
//
// tools/decode-raw.py `load_linear`의 현상 인자를 그대로 옮긴 것이다(카메라 화이트밸런스 ·
// 자동 밝기 없음 · 감마 1 · ProPhoto · 16bit). 「중립 현상」의 조건 (b) — 입력 전달함수가
// 거듭제곱 하나뿐 — 가 측정이 아니라 **구성으로** 성립하는 길이다
// (docs/ARCHITECTURE.md 「중립 현상이 정확히 무엇인가」).
//
// WebAssembly로 빌드한다(tools/build-raw-wasm.sh). 브라우저·Windows·Android(WebView)가
// 같은 바이너리를 쓴다 — 플랫폼마다 현상 코드를 따로 두면 같은 RAW가 조용히 다른 수를
// 낸다. 예전에는 안드로이드 전용 NDK 빌드(JNI)였다.
//
// 내놓는 값은 **화이트 레벨 기준 선형**이다. 1.0(65535)은 센서 포화이지 "씬의 흰색"이
// 아니다. 인코딩(γ1.8)과 "기준 그레이를 어디 놓을 것인가"(헤드룸)는 여기서 정하지
// 않는다 — 부르는 쪽(core/io/rawdecoder.js · core/color/inputs.js `linear-hN`)이 한다.
//
// LibRaw는 LGPL 2.1 / CDDL 1.0 이중 라이선스다. 이 프로젝트는 CDDL 조건으로 쓴다
// (native/raw/README.md).

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "libraw/libraw.h"

namespace {

struct State {
    libraw_processed_image_t* image = nullptr;
    std::string error;
    std::string make;
    std::string model;
    float baselineExposure = 0;
    int dng = 0;
    int flip = 0;
    int rawWidth = 0;
    int rawHeight = 0;
    int half = 0;
};

State g;

void release() {
    if (g.image) LibRaw::dcraw_clear_mem(g.image);
    g = State();
}

int fail(const std::string& msg) {
    std::string keep = msg;
    release();
    g.error = keep;
    return 1;
}

} // namespace

extern "C" {

/**
 * RAW 바이트를 현상한다. 0이면 성공 — 결과는 fs_raw_pixels() 등으로 읽는다.
 *
 * @param half  1이면 디모자이크 없이 2×2를 한 화소로(가로세로 절반). 빠르고 메모리가 1/4 —
 *              폰에서 수천만 화소 RAW를 여는 길이다
 * @param flip  1이면 EXIF 방향대로 돌린다(화소 값은 그대로라 색에는 영향이 없다)
 * @param halfAbove  0이 아니면, 센서 화소 수가 이 값을 넘을 때만 절반으로 푼다. 파일을
 *              열어 봐야 크기를 알 수 있어서 판단을 여기서 한다 — 1200만 화소 폰 DNG까지
 *              절반으로 줄일 이유는 없다
 */
int fs_raw_decode(const uint8_t* data, uint32_t length, int half, int flip, uint32_t halfAbove) {
    release();
    try {
        // LibRaw 객체는 수백 KB라 스택에 두지 않는다
        auto raw = std::make_unique<LibRaw>();
        auto& p = raw->imgdata.params;

        // ── decode-raw.py `load_linear`의 rawpy.postprocess 인자와 같게 ─────────
        p.use_camera_wb = 1;  // use_camera_wb=True
        p.no_auto_bright = 1; // 자동 밝기 = 씬마다 다른 톤. 절대 켜지 않는다
        p.gamm[0] = 1.0;      // gamma=(1, 1) — **선형**. 이 파일의 존재 이유
        p.gamm[1] = 1.0;
        p.output_color = 4;   // ProPhoto
        p.output_bps = 16;
        p.user_flip = flip ? -1 : 0;
        p.half_size = half ? 1 : 0;

        int rc = raw->open_buffer(const_cast<uint8_t*>(data), length);
        if (rc != LIBRAW_SUCCESS) return fail(std::string("RAW로 열 수 없습니다: ") + libraw_strerror(rc));

        g.make = raw->imgdata.idata.make;
        g.model = raw->imgdata.idata.model;
        g.dng = raw->imgdata.idata.dng_version != 0;
        g.flip = raw->imgdata.sizes.flip;
        g.rawWidth = raw->imgdata.sizes.width;
        g.rawHeight = raw->imgdata.sizes.height;
        if (!half && halfAbove && static_cast<uint64_t>(g.rawWidth) * g.rawHeight > halfAbove) p.half_size = 1;
        g.half = p.half_size;
        float be = g.dng ? raw->imgdata.color.dng_levels.baseline_exposure : 0.0f;
        g.baselineExposure = (std::isfinite(be) && be > -8 && be < 8) ? be : 0.0f;

        rc = raw->unpack();
        if (rc != LIBRAW_SUCCESS) {
            std::string msg = std::string("RAW 데이터를 풀지 못했습니다: ") + libraw_strerror(rc);
            if (g.dng) msg += " (JPEG XL·손실 JPEG로 압축한 DNG는 지원하지 않습니다 — 무손실이나 무압축으로 저장하세요)";
            return fail(msg);
        }
        rc = raw->dcraw_process();
        if (rc != LIBRAW_SUCCESS) return fail(std::string("현상에 실패했습니다: ") + libraw_strerror(rc));

        int memErr = 0;
        libraw_processed_image_t* img = raw->dcraw_make_mem_image(&memErr);
        if (!img) return fail(std::string("현상 결과를 만들지 못했습니다: ") + libraw_strerror(memErr));
        if (img->type != LIBRAW_IMAGE_BITMAP || img->colors != 3 || img->bits != 16) {
            LibRaw::dcraw_clear_mem(img);
            return fail("예상하지 못한 현상 결과 형식입니다");
        }
        g.image = img;
        return 0;
    } catch (const std::bad_alloc&) {
        return fail("메모리가 부족합니다");
    } catch (...) {
        return fail("RAW 현상 중 알 수 없는 오류가 났습니다");
    }
}

int fs_raw_width() { return g.image ? g.image->width : 0; }
int fs_raw_height() { return g.image ? g.image->height : 0; }
/** 선형 16bit RGB 인터리브, 화이트 레벨 = 65535. fs_raw_release() 전까지 유효하다. */
const uint16_t* fs_raw_pixels() { return g.image ? reinterpret_cast<const uint16_t*>(g.image->data) : nullptr; }
/** DNG BaselineExposure(스톱). 폰 RAW는 일부러 어둡게 기록하고 이만큼 올리라고 적어 둔다. */
float fs_raw_baseline_exposure() { return g.baselineExposure; }
int fs_raw_is_dng() { return g.dng; }
/** 실제로 절반 크기로 풀었는가(halfAbove에 걸렸을 수 있다). */
int fs_raw_is_half() { return g.half; }
const char* fs_raw_make() { return g.make.c_str(); }
const char* fs_raw_model() { return g.model.c_str(); }
const char* fs_raw_error() { return g.error.c_str(); }
const char* fs_raw_version() { return LibRaw::version(); }
void fs_raw_release() { release(); }

} // extern "C"
