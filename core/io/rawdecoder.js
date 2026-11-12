/**
 * RAW 플랫 현상 — LibRaw(WebAssembly)를 불러 쓴다.
 *
 * 카메라 RAW(ARW·CR3·NEF·RAF …)와 DNG를 **톤 커브 없이** 푼다. 결과는 작업 공간
 * 형식(Uint16 · ProPhoto γ1.8, `core/render/working.js`)이고, 담긴 값은 **화이트 레벨
 * 기준 선형광**이다 — 코드 65535가 센서 포화다.
 *
 * ── 이 값을 엔진이 어떻게 읽나 ──────────────────────────────────────────
 *
 * 화이트 레벨 기준이라 "씬의 18% 그레이"가 어디인지는 이 파일이 모른다. 그것은 엔진의
 * 입력 소스 「리니어 +N스톱」(`core/color/inputs.js` `linear-hN`)이 정한다 — 기준 그레이가
 * 포화에서 N스톱 아래에 있다고 읽는다. 촬영 노출이 달랐으면 엔진 노광으로 민다(조건
 * (a)는 노광 시프트와 대수적으로 같다 — `docs/ARCHITECTURE.md`).
 *
 * `tools/decode-raw.py`와 **같은 LibRaw 판·같은 인자**다(native/raw/filmsim_raw.cpp).
 * 선형값은 화소 단위로 같다(`tools/check-raw.py`). 다른 점 하나 — 저쪽은 ROMM 규격의
 * 발끝 직선부(선형 < 1/512)로 인코딩하고 여기는 순수 거듭제곱이다. 엔진이 읽는 식이
 * 순수 거듭제곱(`v^1.8`)이라 이쪽이 왕복이 정확하다. 차이는 포화에서 9스톱 아래부터다.
 *
 * ── 왜 emscripten의 JS 없이 직접 띄우나 ────────────────────────────────
 *
 * `.wasm`은 `-sSTANDALONE_WASM`으로 빌드했다(tools/build-raw-wasm.sh). 필요한 수입 함수가
 * WASI 여덟 개뿐이라 여기서 채운다. 그래서 노드(검사)·워커·WebView에서 같은 코드로 뜬다.
 * 파일 시스템은 없다 — RAW는 메모리로 넘긴다(`open_buffer`).
 */

const GAMMA = 1.8;

/** 선형 16bit → 작업 인코딩 16bit. 한 번 만들어 둔다(65536항). */
let ENCODE = null;
function encodeTable() {
  if (ENCODE) return ENCODE;
  ENCODE = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) ENCODE[i] = Math.round(Math.pow(i / 65535, 1 / GAMMA) * 65535);
  return ENCODE;
}

/**
 * RAW로 볼 확장자. **내용으로는 못 가른다** — DNG·ARW·NEF·CR2는 전부 TIFF 구조라
 * 첫 바이트가 TIFF와 같다. TIFF로 읽으면 안에 든 작은 미리보기가 열린다.
 */
const RAW_EXTENSIONS = new Set([
  "dng", "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "raf", "orf", "rw2", "rwl",
  "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "mrw", "kdc", "dcr", "raw",
]);

function isRawName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return !!m && RAW_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * @param {Uint8Array|ArrayBuffer} wasmBytes  apps/studio/vendor/filmsim-raw.wasm
 * @returns {{decode: Function, version: () => string}}
 */
function createRawDecoder(wasmBytes) {
  // 모듈은 한 번만 컴파일하고 **인스턴스는 현상마다 새로** 만든다. WebAssembly 메모리는
  // 늘기만 하고 줄지 않아서, 6천만 화소를 한 번 풀면 1GB가 그대로 남는다. 인스턴스를
  // 버려야 그 메모리가 돌아온다
  const module = new WebAssembly.Module(wasmBytes);

  function instantiate() {
    let memory = null;
    const u32 = () => new Uint32Array(memory.buffer);
    const wasi = {
      proc_exit(code) { throw new Error(`RAW 현상부가 종료했습니다 (${code})`); },
      // LibRaw가 stderr로 찍는 진단은 버린다. 다 썼다고 답해야 다시 시도하지 않는다
      fd_write(fd, iov, count, written) {
        const m = u32();
        let n = 0;
        for (let i = 0; i < count; i++) n += m[(iov >>> 2) + i * 2 + 1];
        m[written >>> 2] = n;
        return 0;
      },
      fd_read(fd, iov, count, read) { u32()[read >>> 2] = 0; return 0; },
      fd_close() { return 0; },
      fd_seek() { return 70; }, // ESPIPE — 파일이 없다
      environ_sizes_get(count, size) { const m = u32(); m[count >>> 2] = 0; m[size >>> 2] = 0; return 0; },
      environ_get() { return 0; },
    };
    const instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasi,
      env: { emscripten_notify_memory_growth() {} },
    });
    memory = instance.exports.memory;
    if (instance.exports._initialize) instance.exports._initialize();
    return instance.exports;
  }

  function cstring(x, ptr) {
    const bytes = new Uint8Array(x.memory.buffer);
    let end = ptr >>> 0;
    while (bytes[end]) end++;
    // TextDecoder는 브라우저·노드 공통이다. 오류 문구가 한글(UTF-8)이다
    return new TextDecoder("utf-8").decode(bytes.subarray(ptr >>> 0, end));
  }

  /**
   * @param {Uint8Array} bytes  RAW 파일 전체
   * @param {object} [opts]
   * @param {boolean} [opts.half]    가로세로 절반으로(디모자이크 생략). 메모리 1/4
   * @param {number} [opts.halfAbove] 센서 화소 수가 이 값을 넘을 때만 절반으로
   * @param {boolean} [opts.flip]    EXIF 방향대로 돌린다. 기본 true
   * @param {boolean} [opts.linear]  인코딩하지 않은 선형 16bit를 돌려준다(검사용)
   * @returns {{width:number, height:number, data:Uint16Array, clippedPercent:number,
   *            make:string, model:string, dng:boolean, baselineExposure:number, half:boolean}}
   */
  function decode(bytes, opts) {
    const o = opts || {};
    const x = instantiate();
    const input = x.malloc(bytes.length) >>> 0;
    if (!input) throw new Error("메모리가 부족합니다 (RAW 파일을 올리지 못했습니다)");
    new Uint8Array(x.memory.buffer).set(bytes, input);

    let rc;
    try {
      rc = x.fs_raw_decode(input, bytes.length, o.half ? 1 : 0, o.flip === false ? 0 : 1, o.halfAbove >>> 0);
    } catch (e) {
      // 메모리를 더 못 늘리면 WebAssembly가 트랩을 던진다
      const err = new Error("RAW 현상 중 메모리가 부족했습니다");
      err.outOfMemory = true;
      throw err;
    }
    if (rc !== 0) {
      const msg = cstring(x, x.fs_raw_error());
      const err = new Error(msg || "RAW 현상에 실패했습니다");
      err.outOfMemory = /메모리|memory/i.test(msg);
      throw err;
    }

    const width = x.fs_raw_width(), height = x.fs_raw_height();
    const n = width * height * 3;
    const lin = new Uint16Array(x.memory.buffer, x.fs_raw_pixels() >>> 0, n);
    const data = new Uint16Array(n);
    let clipped = 0;
    if (o.linear) {
      data.set(lin);
    } else {
      const enc = encodeTable();
      for (let i = 0; i < n; i += 3) {
        const r = lin[i], g = lin[i + 1], b = lin[i + 2];
        if (r === 65535 || g === 65535 || b === 65535) clipped++;
        data[i] = enc[r]; data[i + 1] = enc[g]; data[i + 2] = enc[b];
      }
    }
    const out = {
      width, height, data,
      clippedPercent: n ? (100 * clipped) / (n / 3) : 0,
      make: cstring(x, x.fs_raw_make()),
      model: cstring(x, x.fs_raw_model()),
      dng: x.fs_raw_is_dng() !== 0,
      baselineExposure: x.fs_raw_baseline_exposure(),
      half: x.fs_raw_is_half() !== 0,
    };
    x.fs_raw_release();
    return out; // 인스턴스(와 그 메모리)는 여기서 버려진다
  }

  return {
    decode,
    version() { const x = instantiate(); return cstring(x, x.fs_raw_version()); },
  };
}

module.exports = { createRawDecoder, isRawName, RAW_EXTENSIONS };
