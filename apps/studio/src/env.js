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

/** base64 → 바이트. RAW 현상부(.wasm)가 HTML 안에 base64로 들어 있다. */
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {(label:string, fraction:number)=>void} progress
 * @param {()=>string|null} [rawWasmBase64]  RAW 현상부의 base64. 메인 스레드는 빌드가 박아 둔
 *   전역에서, 워커는 메인이 보내 준 것에서 읽는다 — 같은 1MB를 HTML에 두 번 싣지 않는다
 */
function browserEnv(progress, rawWasmBase64) {
  let wasm = null;
  return {
    progress,

    rawWasm() {
      if (wasm) return wasm;
      const b64 = rawWasmBase64 && rawWasmBase64();
      if (!b64) throw new Error("이 빌드에는 RAW 현상부가 들어 있지 않습니다");
      wasm = fromBase64(b64);
      return wasm;
    },

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
        throw new Error("이 파일을 열 수 없습니다 — RAW·DNG·JPEG·PNG·WebP·TIFF(8/16비트)를 지원합니다");
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
