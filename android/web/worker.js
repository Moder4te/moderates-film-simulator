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
 */

importScripts("engine.bundle.js");

const R = self.FilmSimEngine.require;
const film = R("core/color/film.js");
const films = R("core/color/films.js");
const paper = R("core/color/paper.js");
const scanner = R("core/color/scanner.js");
const lut = R("core/color/lut.js");
const colorspace = R("core/color/colorspace.js");
const params = R("apps/engine/src/params.js");

/** 마지막으로 합성한 LUT. 같은 설정으로 미리보기·저장을 반복할 때 다시 굽지 않는다. */
let cached = { key: null, size: 0, table: null };

function composedLut(p, size) {
  const key = JSON.stringify([p.film, p.grading, size]);
  if (cached.key === key) return cached;

  const engine = film.buildForParams(p, size);
  const table = new Float32Array(size * size * size * 3);
  const d = size - 1;
  const pp = [0, 0, 0];
  const looked = [0, 0, 0];
  const srgb = [0, 0, 0];
  let o = 0;
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
    papers: paper.all().map((x) => ({ id: x.id, name: x.displayName, note: x.note })),
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
      const data = new Uint8ClampedArray(msg.buffer);
      if (film.hasEffect(p)) {
        const c = composedLut(p, msg.size);
        applyRgba(data, c.table, c.size);
      }
      self.postMessage({ id: msg.id, ok: true, buffer: data.buffer, ms: Date.now() - t0 }, [data.buffer]);
      return;
    }
    throw new Error("알 수 없는 요청: " + msg.type);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.stack) || err) });
  }
};
