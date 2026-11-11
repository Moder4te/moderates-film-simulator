/**
 * 브라우저 환경 — 세션이 스스로 못 하는 세 가지(이미지 디코드·캔버스 인코드·zlib).
 * 워커와 메인 스레드 양쪽에서 같은 것을 쓴다. DOM 캔버스는 워커에 없으므로
 * OffscreenCanvas를 먼저 찾고, 없을 때만(메인 스레드 폴백) DOM 캔버스를 만든다.
 */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  throw new Error("이 브라우저는 캔버스를 만들 수 없습니다");
}

function browserEnv(progress) {
  return {
    progress,

    // TIFF의 ZIP 압축은 zlib 스트림이다 — DecompressionStream의 "deflate"가 그것
    async inflate(bytes) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("이 브라우저는 ZIP 압축 TIFF를 풀 수 없습니다 — 무압축이나 LZW로 저장하세요");
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },

    // JPEG·PNG·WebP 등 — 브라우저가 풀어 준다. 결과는 sRGB 8bit다(박힌 프로파일은
    // 브라우저가 sRGB로 옮기고, EXIF 회전도 적용된다)
    async decodeBitmap(bytes, type) {
      let bm;
      try {
        bm = await createImageBitmap(new Blob([bytes], { type: type || "" }));
      } catch (e) {
        throw new Error("이 파일을 열 수 없습니다 — JPEG·PNG·WebP·TIFF(8/16비트)를 지원합니다");
      }
      const w = bm.width, h = bm.height;
      let ctx;
      try {
        ctx = makeCanvas(w, h).getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bm, 0, 0);
      } finally {
        if (bm.close) bm.close();
      }
      const rgba = ctx.getImageData(0, 0, w, h).data;
      return { width: w, height: h, rgba };
    },

    canvasEncoder(w, h) {
      let canvas, ctx;
      try {
        canvas = makeCanvas(w, h);
        ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no context");
      } catch (e) {
        throw new Error(`${w}×${h} 크기의 캔버스를 만들 수 없습니다 — 「긴 변」을 줄이거나 TIFF로 내보내세요`);
      }
      return {
        put(rgba, y, rows) {
          ctx.putImageData(new ImageData(rgba, w, rows), 0, y);
        },
        async finish(type, quality) {
          if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
          return new Promise((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 인코딩 실패"))), type, quality));
        },
      };
    },

    blob: (parts, type) => new Blob(parts, { type }),
  };
}

module.exports = { browserEnv };
