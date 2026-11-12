// com.filmsim.engine.RawDecoder의 네이티브 쪽. 현상한 RAW는 핸들(포인터)로 들고 있다가
// 미리보기 바이트·LUT 적용에 쓴다. 큰 버퍼가 자바 힙을 거치지 않게 하려는 것이다.

#include <jni.h>
#include <android/bitmap.h>

#include <cstdio>
#include <string>

#include "filmsim_raw.h"

namespace {

thread_local std::string lastError;

filmsim::RawImage* fromHandle(jlong h) { return reinterpret_cast<filmsim::RawImage*>(h); }

std::string jsonEscape(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        if (static_cast<unsigned char>(c) < 0x20) continue;
        o += c;
    }
    return o;
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_filmsim_engine_RawDecoder_nativeDecode(JNIEnv* env, jclass, jstring jpath, jboolean half, jint previewEdge) {
    const char* path = env->GetStringUTFChars(jpath, nullptr);
    auto* img = new filmsim::RawImage();
    filmsim::DecodeOptions opt;
    opt.halfSize = half;
    opt.previewEdge = previewEdge;
    std::string err;
    bool ok = false;
    try {
        ok = filmsim::decodeRaw(path, opt, *img, err);
    } catch (const std::bad_alloc&) {
        err = "메모리가 부족하다 — 반해상도 현상을 켜 보세요";
    } catch (...) {
        err = "현상 중 알 수 없는 오류";
    }
    env->ReleaseStringUTFChars(jpath, path);
    if (!ok) {
        delete img;
        lastError = err;
        return 0;
    }
    return reinterpret_cast<jlong>(img);
}

JNIEXPORT jstring JNICALL
Java_com_filmsim_engine_RawDecoder_nativeLastError(JNIEnv* env, jclass) {
    return env->NewStringUTF(lastError.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_filmsim_engine_RawDecoder_nativeInfo(JNIEnv* env, jclass, jlong h) {
    const auto* img = fromHandle(h);
    char buf[160];
    std::snprintf(buf, sizeof buf,
                  "\"width\":%d,\"height\":%d,\"previewWidth\":%d,\"previewHeight\":%d,"
                  "\"baselineExposure\":%.4f,\"dng\":%s,\"clippedPercent\":%.4f",
                  img->width, img->height, img->previewWidth, img->previewHeight,
                  img->baselineExposure, img->dng ? "true" : "false", img->clippedPercent);
    std::string json = "{" + std::string(buf) + ",\"make\":\"" + jsonEscape(img->make) + "\",\"model\":\"" +
                       jsonEscape(img->model) + "\"}";
    return env->NewStringUTF(json.c_str());
}

/** 미리보기 16bit RGB를 리틀엔디언 바이트로. WebView가 Uint16Array로 그대로 읽는다. */
JNIEXPORT jbyteArray JNICALL
Java_com_filmsim_engine_RawDecoder_nativePreview(JNIEnv* env, jclass, jlong h) {
    const auto* img = fromHandle(h);
    const jsize bytes = static_cast<jsize>(img->preview.size() * sizeof(uint16_t));
    jbyteArray arr = env->NewByteArray(bytes);
    if (arr) env->SetByteArrayRegion(arr, 0, bytes, reinterpret_cast<const jbyte*>(img->preview.data()));
    return arr;
}

/** 원본 해상도에 LUT을 걸어 ARGB_8888 비트맵(크기 = width×height)에 쓴다. 0이면 성공. */
JNIEXPORT jint JNICALL
Java_com_filmsim_engine_RawDecoder_nativeApply(JNIEnv* env, jclass, jlong h, jfloatArray jlut, jint size, jobject bitmap) {
    const auto* img = fromHandle(h);
    if (env->GetArrayLength(jlut) != size * size * size * 3) return -1;

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) return -2;
    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 || static_cast<int>(info.width) != img->width ||
        static_cast<int>(info.height) != img->height || info.stride != info.width * 4) {
        return -3;
    }
    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) return -4;

    jfloat* lut = env->GetFloatArrayElements(jlut, nullptr);
    filmsim::applyLut(img->pixels.data(), static_cast<size_t>(img->width) * img->height, lut, size,
                      static_cast<uint8_t*>(pixels));
    env->ReleaseFloatArrayElements(jlut, lut, JNI_ABORT);
    AndroidBitmap_unlockPixels(env, bitmap);
    return 0;
}

JNIEXPORT void JNICALL
Java_com_filmsim_engine_RawDecoder_nativeFree(JNIEnv*, jclass, jlong h) {
    delete fromHandle(h);
}

} // extern "C"
