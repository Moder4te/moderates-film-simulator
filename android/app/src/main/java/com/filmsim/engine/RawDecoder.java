package com.filmsim.engine;

/**
 * LibRaw 현상(네이티브, src/main/cpp). 현상 인자는 tools/decode-raw.py와 같다 —
 * 카메라 화이트밸런스, 자동 밝기 없음, 감마 1(선형), ProPhoto, 16bit.
 * tools/check-raw-native.py가 같은 RAW를 두 길로 풀어 화소 단위로 대조한다.
 *
 * 현상 결과는 네이티브 메모리에 둔다(24MP면 144MB). 자바 힙을 거치지 않는다.
 */
final class RawDecoder implements AutoCloseable {

    static {
        System.loadLibrary("filmsim_raw");
    }

    private long handle;

    private RawDecoder(long handle) {
        this.handle = handle;
    }

    /** 실패하면 사유를 담은 예외. */
    static RawDecoder decode(String path, boolean halfSize, int previewEdge) {
        long h = nativeDecode(path, halfSize, previewEdge);
        if (h == 0) throw new IllegalStateException(nativeLastError());
        return new RawDecoder(h);
    }

    /** width·height·previewWidth·previewHeight·baselineExposure·dng·clippedPercent·make·model JSON. */
    synchronized String info() {
        return nativeInfo(alive());
    }

    /** 미리보기 16bit RGB(리틀엔디언). */
    synchronized byte[] preview() {
        return nativePreview(alive());
    }

    /** 원본 해상도에 LUT(.cube 순서, 출력 sRGB)을 걸어 RGBA_8888 비트맵에 쓴다. */
    synchronized void apply(float[] lut, int size, android.graphics.Bitmap out) {
        int rc = nativeApply(alive(), lut, size, out);
        if (rc != 0) throw new IllegalStateException("LUT 적용 실패 (" + rc + ")");
    }

    private long alive() {
        if (handle == 0) throw new IllegalStateException("이미 닫힌 RAW");
        return handle;
    }

    @Override
    public synchronized void close() {
        if (handle != 0) nativeFree(handle);
        handle = 0;
    }

    private static native long nativeDecode(String path, boolean halfSize, int previewEdge);
    private static native String nativeLastError();
    private static native String nativeInfo(long h);
    private static native byte[] nativePreview(long h);
    private static native int nativeApply(long h, float[] lut, int size, android.graphics.Bitmap out);
    private static native void nativeFree(long h);
}
