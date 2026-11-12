/**
 * 색 계산 워커. 엔진(core/color)은 여기서만 돈다 — 큰 사진에 LUT을 거는 동안
 * 화면이 멈추지 않게 하려는 것이다.
 *
 * ── 색공간 ───────────────────────────────────────────────────────────────
 *
 * 엔진 LUT은 **ProPhoto γ1.8 → ProPhoto γ1.8** 사상이다(core/color/film.js).
 * 휴대폰 사진과 캔버스는 sRGB다. 그래서 sRGB 격자의 각 점을
 *
 *   sRGB → ProPhoto  →  엔진 LUT  →  ProPhoto → sRGB
 *
 * 로 통과시켜 **sRGB → sRGB LUT 한 장**으로 합성해 둔다. 픽셀마다 거듭제곱을
 * 여섯 번 부르는 대신 사면체 보간 한 번이면 된다. 변환식은 엔진 것을 그대로 쓴다
 * (`colorspace.srgbToProPhoto` · `colorspace.proPhotoToSrgb`) — 팔레트 스와치가
 * 엔진 LUT을 통과하는 길과 같다.
 *
 * ⚠️ 휴대폰 JPEG은 「중립 현상」이 아니다. 카메라 앱의 톤 커브가 이미 걸려 있어
 * 엔진이 전제하는 조건 (b)를 만족하지 않는다(docs/ARCHITECTURE.md). 노출 슬라이더로
 * (a)는 상쇄되지만 (b)는 못 고친다 — 결과는 "근사"로 읽어야 한다.
 *
 * **RAW는 다르다.** 앱이 LibRaw로 톤 커브 없이 직접 현상하므로(tools/decode-raw.py와
 * 같은 인자 — android/app/src/main/cpp/filmsim_raw.cpp) 조건 (b)가 구성상 성립한다.
 * 엔진은 그것을 「리니어 +N스톱」 입력으로 읽는다. 이것이 정식 경로다.
 */

importScripts("engine.bundle.js");

const R = self.FilmSimEngine.require;
const film = R("core/color/film.js");
const films = R("core/color/films.js");
const paper = R("core/color/paper.js");
const scanner = R("core/color/scanner.js");
const lut = R("core/color/lut.js");
const colorspace = R("core/color/colorspace.js");
const inputs = R("core/color/inputs.js");
const params = R("apps/engine/src/params.js");

/** 마지막으로 합성한 LUT. 같은 설정으로 미리보기·저장을 반복할 때 다시 굽지 않는다. */
let cached = { key: null, size: 0, table: null };

/**
 * 소스 종류별로 「코드 → 화면 sRGB」 LUT 한 장을 만든다.
 *
 *   srgb8  휴대폰 JPEG 등. 격자가 sRGB라 엔진 LUT 앞뒤로 공간을 옮긴다(위 머리말).
 *   raw16  앱이 현상한 RAW. 이미 ProPhoto γ1.8(화이트 레벨 기준 선형) 코드라 엔진
 *          LUT의 입력 축과 **같은 격자**다 — 출력만 sRGB로 옮기면 된다. 보간이 한 번뿐.
 *
 * original=true면 필름 없이 「그냥 선형으로 본 것」을 만든다(RAW 비교용). 입력 전달함수로
 * 풀어 기준 그레이를 0.18에 놓고 잘라서 보여 준다 — 톤 커브가 없으니 밋밋하고 하이라이트가
 * 날아가는 것이 정상이다.
 */
function composedLut(p, size, source, original) {
  const key = JSON.stringify([p.film, p.grading, size, source, !!original]);
  if (cached.key === key) return cached;

  const table = new Float32Array(size * size * size * 3);
  const d = size - 1;
  const pp = [0, 0, 0];
  const looked = [0, 0, 0];
  const srgb = [0, 0, 0];
  let o = 0;

  if (source === "raw16") {
    if (original) {
      const decode = inputs.byId(p.film.input).decode;
      for (let b = 0; b < size; b++) {
        for (let g = 0; g < size; g++) {
          for (let r = 0; r < size; r++) {
            colorspace.proPhotoToSrgb(
              colorspace.prophotoEncode(decode(r / d)),
              colorspace.prophotoEncode(decode(g / d)),
              colorspace.prophotoEncode(decode(b / d)),
              srgb
            );
            table[o++] = srgb[0];
            table[o++] = srgb[1];
            table[o++] = srgb[2];
          }
        }
      }
    } else {
      const engine = film.buildForParams(p, size);
      for (let i = 0; i < engine.length; i += 3) {
        colorspace.proPhotoToSrgb(engine[i], engine[i + 1], engine[i + 2], srgb);
        table[i] = srgb[0];
        table[i + 1] = srgb[1];
        table[i + 2] = srgb[2];
      }
    }
  } else {
    const engine = film.buildForParams(p, size);
    // .cube 순서 — R이 가장 빨리 변한다(core/color/lut.js).
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          colorspace.srgbToProPhoto(r / d, g / d, b / d, pp);
          lut.sample(engine, size, pp[0], pp[1], pp[2], looked);
          colorspace.proPhotoToSrgb(looked[0], looked[1], looked[2], srgb);
          table[o++] = srgb[0];
          table[o++] = srgb[1];
          table[o++] = srgb[2];
        }
      }
    }
  }
  cached = { key, size, table };
  return cached;
}

/** RGBA 8bit 버퍼에 제자리로 건다. 알파는 그대로 둔다. */
function applyRgba(data, table, size) {
  const inv = 1 / 255;
  const tmp = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    lut.sample(table, size, data[i] * inv, data[i + 1] * inv, data[i + 2] * inv, tmp);
    // 반올림한다 — 정수 버퍼로 나가는 자리의 규약(docs/ARCHITECTURE.md 양자화 규약).
    // Uint8ClampedArray는 대입 시 반올림·클램프를 스스로 한다.
    data[i] = tmp[0] * 255;
    data[i + 1] = tmp[1] * 255;
    data[i + 2] = tmp[2] * 255;
  }
}

/** RAW 미리보기(16bit RGB) → RGBA 8bit. 네이티브 저장 경로(filmsim_raw.cpp applyLut)와 같은 계산이다. */
function applyRgb16(src, table, size) {
  const out = new Uint8ClampedArray((src.length / 3) * 4);
  const inv = 1 / 65535;
  const tmp = [0, 0, 0];
  for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
    lut.sample(table, size, src[i] * inv, src[i + 1] * inv, src[i + 2] * inv, tmp);
    out[j] = tmp[0] * 255;
    out[j + 1] = tmp[1] * 255;
    out[j + 2] = tmp[2] * 255;
    out[j + 3] = 255;
  }
  return out;
}

function catalog() {
  return {
    films: films.all().map((f) => ({
      id: f.id,
      name: f.displayName,
      manufacturer: f.manufacturer,
      iso: f.iso,
      balance: f.balance,
      exposureRange: f.exposureRange,
    })),
    papers: paper.all().map((x) => ({ id: x.id, name: x.displayName, note: x.note, hasCurves: !!x.curves })),
    headrooms: inputs.HEADROOMS,
    defaultHeadroom: inputs.DEFAULT_HEADROOM,
    scanners: scanner.all().map((x) => ({ id: x.id, name: x.displayName, note: x.note })),
    defaults: params.defaultParams(),
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "catalog") {
      self.postMessage({ id: msg.id, ok: true, catalog: catalog() });
      return;
    }
    if (msg.type === "render") {
      const t0 = Date.now();
      const p = params.migrate(msg.params);
      const source = msg.source || "srgb8";
      let data;
      if (source === "raw16") {
        const c = composedLut(p, msg.size, source, msg.original);
        data = applyRgb16(new Uint16Array(msg.buffer), c.table, c.size);
      } else {
        data = new Uint8ClampedArray(msg.buffer);
        if (film.hasEffect(p)) {
          const c = composedLut(p, msg.size, source, false);
          applyRgba(data, c.table, c.size);
        }
      }
      self.postMessage({ id: msg.id, ok: true, buffer: data.buffer, ms: Date.now() - t0 }, [data.buffer]);
      return;
    }
    if (msg.type === "lut") {
      // 원본 해상도 RAW는 네이티브가 직접 건다 — 그쪽에 넘길 LUT(사본)만 만든다.
      const p = params.migrate(msg.params);
      const table = composedLut(p, msg.size, msg.source, false).table.slice();
      self.postMessage({ id: msg.id, ok: true, table: table.buffer, size: msg.size }, [table.buffer]);
      return;
    }
    if (msg.type === "warning") {
      const p = params.migrate(msg.params);
      const pp = paper.byId(p.film.paper);
      self.postMessage({ id: msg.id, ok: true, warning: inputs.combinationWarning(p.film.input, !!(pp && pp.curves)) });
      return;
    }
    throw new Error("알 수 없는 요청: " + msg.type);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.stack) || err) });
  }
};
