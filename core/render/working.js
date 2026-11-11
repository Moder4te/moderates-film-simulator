/**
 * 작업 공간 — 독립 실행형이 픽셀을 들고 있는 **단 하나의 형식**.
 *
 *     Uint16Array, RGB 인터리브, 0~65535, ProPhoto 원색 · 감마 1.8
 *
 * 필름 엔진이 전제하는 바로 그 인코딩이다(`core/color/inputs.js`의 `prophoto`).
 * 그래서 엔진 LUT이 변환 없이 그대로 걸린다.
 *
 * ── 왜 들어올 때 옮기는가 ───────────────────────────────────────────────
 *
 * Photoshop 플러그인은 문서 값을 그대로 읽었다. 문서가 sRGB면 엔진이 그 코드를
 * γ1.8로 **잘못 읽어** 노광 기준이 반 스톱 밀렸고, 그래서 "ProPhoto가 아니면 경고"가
 * 필요했다(`colorspace.workingSpaceCheck`). 호스트가 색공간을 쥐고 있어 플러그인이
 * 바꿀 수 없었기 때문이다.
 *
 * 여기는 파일을 직접 연다. 열 때 한 번 작업 공간으로 옮겨 두면 **그 종류의 오류가
 * 구조적으로 없어진다** — sRGB JPEG을 넣어도 18% 그레이는 0.3857에 온다. 경고할 일
 * 자체가 사라진다(톤 커브가 이미 걸려 있다는 것은 여전히 알려야 한다 — 그건 색공간이
 * 아니라 현상의 문제다. `pipeline.advise`).
 *
 * 마감(톤·할레이션·그레인)도 같은 버퍼 위에서 돈다. 감마가 하나라 "문서가 ProPhoto면
 * 1.8, 아니면 2.2"로 갈라 짐작할 필요가 없다.
 */

const colorspace = require("../color/colorspace");
const inputs = require("../color/inputs");
const tone = require("../optics/tone");

const GAMMA = inputs.WORKING_GAMMA;
const MAX16 = 65535;

// ── 전달함수 표 ──────────────────────────────────────────────────────────
//
// 픽셀마다 pow를 부르면 24MP에 수 초다. 디코드는 값에 대해 매끄러워 균등 표 +
// 선형보간이면 충분하고, 인코드는 0 근처 기울기가 무한대라 **√ 축**으로 표를 잡는다
// (`core/optics/halation.js`와 같은 수법 — √L에 대해서는 L^(1/γ)이 완만하다).

const DEC_N = 4096;
const DEC = new Float32Array(DEC_N + 2);
for (let i = 0; i <= DEC_N + 1; i++) DEC[i] = Math.pow(Math.min(i / DEC_N, 1), GAMMA);

/** 작업 인코딩값(0~1) → 선형광. */
function decode(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const u = v * DEC_N, k = u | 0;
  return DEC[k] + (DEC[k + 1] - DEC[k]) * (u - k);
}

const ENC_N = 8192;
function sqrtTable(fn) {
  const t = new Float32Array(ENC_N + 2);
  for (let i = 0; i <= ENC_N + 1; i++) {
    const s = Math.min(i / ENC_N, 1);
    t[i] = fn(s * s);
  }
  return t;
}
const ENC = sqrtTable((L) => Math.pow(L, 1 / GAMMA));
const ENC_SRGB = sqrtTable(colorspace.srgbEncode);

function lookupSqrt(table, L) {
  if (L <= 0) return 0;
  if (L >= 1) return table[ENC_N];
  const u = Math.sqrt(L) * ENC_N, k = u | 0;
  return table[k] + (table[k + 1] - table[k]) * (u - k);
}

/** 선형광 → 작업 인코딩값(0~1). */
function encode(L) {
  return lookupSqrt(ENC, L);
}

// ── 들어오기 ─────────────────────────────────────────────────────────────

const M_ADOBE_TO_PROPHOTO = (() => {
  const a = colorspace.M_SRGB_TO_PROPHOTO, b = colorspace.M_ADOBE_TO_SRGB;
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
})();

/**
 * 우리가 옮길 줄 아는 원본 공간. `matrix`가 없으면 이미 작업 공간이다.
 * (P3는 표를 넣지 않았다 — 브라우저가 풀어 준 JPEG·PNG는 이미 sRGB로 와 있고,
 * P3 프로파일이 박힌 TIFF만 해당하는데 아직 받아 본 적이 없다.)
 */
const SOURCE_SPACES = {
  prophoto: { displayName: "ProPhoto RGB", decode: null, matrix: null },
  srgb: { displayName: "sRGB", decode: colorspace.srgbDecode, matrix: colorspace.M_SRGB_TO_PROPHOTO },
  adobergb: { displayName: "Adobe RGB", decode: (v) => Math.pow(v, 2.19921875), matrix: M_ADOBE_TO_PROPHOTO },
};

/**
 * 원본 픽셀을 작업 공간으로 옮긴다.
 *
 * @param {Uint8Array|Uint8ClampedArray|Uint16Array} data  인터리브
 * @param {number} comps   원본 채널 수(3 또는 4 — 알파는 버린다)
 * @param {number} count   픽셀 수
 * @param {"prophoto"|"srgb"|"adobergb"} space
 * @returns {Uint16Array}  count × 3
 */
function toWorking(data, comps, count, space) {
  const sp = SOURCE_SPACES[space];
  if (!sp) throw new Error(`모르는 원본 색공간: ${space}`);
  const maxV = data.BYTES_PER_ELEMENT === 2 ? MAX16 : 255;
  const out = new Uint16Array(count * 3);

  if (!sp.matrix) {
    // 이미 작업 공간 — 심도만 맞춘다. 8bit는 ×257이 정확히 0→0, 255→65535다.
    if (maxV === MAX16 && comps === 3) { out.set(data.subarray(0, count * 3)); return out; }
    const k = maxV === 255 ? 257 : 1;
    for (let p = 0, i = 0, o = 0; p < count; p++, i += comps, o += 3) {
      out[o] = data[i] * k; out[o + 1] = data[i + 1] * k; out[o + 2] = data[i + 2] * k;
    }
    return out;
  }

  const lin = new Float32Array(maxV + 1);
  for (let i = 0; i <= maxV; i++) lin[i] = sp.decode(i / maxV);
  const m = sp.matrix;
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
  for (let p = 0, i = 0, o = 0; p < count; p++, i += comps, o += 3) {
    const r = lin[data[i]], g = lin[data[i + 1]], b = lin[data[i + 2]];
    out[o] = encode(m00 * r + m01 * g + m02 * b) * MAX16 + 0.5;
    out[o + 1] = encode(m10 * r + m11 * g + m12 * b) * MAX16 + 0.5;
    out[o + 2] = encode(m20 * r + m21 * g + m22 * b) * MAX16 + 0.5;
  }
  return out;
}

// ── 나가기 ───────────────────────────────────────────────────────────────

// TPDF 디더 표. 길이가 소수라 이미지 폭과 인수를 공유하지 않는다
// (`core/optics/tone.js`의 DITHER_N과 같은 이유). **절대 좌표**로 조회하므로 띠를
// 어떻게 나누든 같은 픽셀에는 같은 잡음이 온다.
const DITHER_N = 65537;
let DITHER = null;
function ditherTable() {
  if (DITHER) return DITHER;
  const rnd = tone.mulberry32(0x9e3779b9);
  DITHER = new Float32Array(DITHER_N);
  for (let i = 0; i < DITHER_N; i++) DITHER[i] = rnd() - rnd();
  return DITHER;
}

/**
 * 작업 float 띠 → sRGB 8bit RGBA. 화면·JPEG·PNG용이다.
 *
 * ProPhoto는 sRGB보다 넓어서 행렬을 지나면 범위 밖 값이 나온다. 채널마다 자르면
 * 색상이 틀어지므로 광도를 지키며 회색 쪽으로 당긴다(`tone.fitGamut`).
 *
 * @param {Float32Array} strip  w·rows·3, 작업 인코딩 0~1
 * @param {number} w
 * @param {number} rows
 * @param {number} x0  이 띠의 전체 이미지 좌표(디더용)
 * @param {number} y0
 * @param {number} fullW 전체 폭(디더용)
 * @param {Uint8ClampedArray} out  w·rows·4
 * @param {boolean} dither
 */
function toSRGB8(strip, w, rows, x0, y0, fullW, out, dither) {
  const m = colorspace.M_PROPHOTO_TO_SRGB;
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
  const dt = dither ? ditherTable() : null;
  const px = [0, 0, 0];
  for (let y = 0, i = 0, o = 0; y < rows; y++) {
    let di = dt ? (((y0 + y) * fullW + x0) * 3) % DITHER_N : 0;
    for (let x = 0; x < w; x++, i += 3, o += 4) {
      const r = decode(strip[i]), g = decode(strip[i + 1]), b = decode(strip[i + 2]);
      px[0] = m00 * r + m01 * g + m02 * b;
      px[1] = m10 * r + m11 * g + m12 * b;
      px[2] = m20 * r + m21 * g + m22 * b;
      tone.fitGamut(px);
      for (let c = 0; c < 3; c++) {
        let q = lookupSqrt(ENC_SRGB, px[c]) * 255;
        if (dt) { q += dt[di]; if (++di >= DITHER_N) di = 0; }
        out[o + c] = q <= 0 ? 0 : q >= 255 ? 255 : (q + 0.5) | 0;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** 작업 float 띠 → 16bit 코드(TIFF용). 반올림한다 — 버리면 채널당 −0.5LSB 편향이다. */
function toCodes16(strip, out) {
  for (let i = 0; i < strip.length; i++) {
    const q = strip[i] * MAX16;
    out[i] = q <= 0 ? 0 : q >= MAX16 ? MAX16 : (q + 0.5) | 0;
  }
  return out;
}

// ── 축소 ─────────────────────────────────────────────────────────────────

/**
 * 면적 평균 축소. 미리보기 대리본과 "긴 변 지정" 내보내기에 쓴다.
 *
 * **선형광에서 평균한다.** 인코딩값을 그대로 평균하면 밝은 점이 어둡게 뭉개진다 —
 * 할레이션 문턱을 넘던 스페큘러가 대리본에서 사라져 미리보기와 결과가 달라진다.
 *
 * @param {{width:number,height:number,data:Uint16Array}} img
 * @returns {{width:number,height:number,data:Uint16Array}}
 */
function resize(img, w2, h2) {
  const { width: w, height: h, data } = img;
  if (w2 === w && h2 === h) return img;
  if (w2 > w || h2 > h) throw new Error("resize: 확대는 하지 않는다");

  const lin = new Float32Array(MAX16 + 1);
  for (let i = 0; i <= MAX16; i++) lin[i] = Math.pow(i / MAX16, GAMMA);

  // 출력 한 칸이 덮는 입력 구간 [a, b) — 양 끝 칸은 덮인 만큼만 센다
  function spans(n, n2) {
    const s = n / n2;
    const from = new Int32Array(n2), to = new Int32Array(n2);
    const wa = new Float32Array(n2), wb = new Float32Array(n2);
    for (let j = 0; j < n2; j++) {
      const a = j * s, b = Math.min(n, (j + 1) * s);
      from[j] = Math.floor(a);
      to[j] = Math.min(n - 1, Math.ceil(b) - 1);
      wa[j] = 1 - (a - from[j]);
      wb[j] = to[j] > from[j] ? b - to[j] : wa[j];
    }
    return { from, to, wa, wb, s };
  }
  const sx = spans(w, w2), sy = spans(h, h2);

  const out = new Uint16Array(w2 * h2 * 3);
  const row = new Float32Array(w2 * 3); // 가로로 접은 한 줄
  const acc = new Float32Array(w2 * 3);
  for (let j = 0; j < h2; j++) {
    acc.fill(0);
    for (let y = sy.from[j]; y <= sy.to[j]; y++) {
      const wy = y === sy.from[j] ? sy.wa[j] : y === sy.to[j] ? sy.wb[j] : 1;
      const base = y * w * 3;
      for (let i = 0; i < w2; i++) {
        let r = 0, g = 0, b = 0;
        const a = sx.from[i], z = sx.to[i];
        for (let x = a; x <= z; x++) {
          const wx = x === a ? sx.wa[i] : x === z ? sx.wb[i] : 1;
          const p = base + x * 3;
          r += lin[data[p]] * wx; g += lin[data[p + 1]] * wx; b += lin[data[p + 2]] * wx;
        }
        row[i * 3] = r; row[i * 3 + 1] = g; row[i * 3 + 2] = b;
      }
      for (let k = 0; k < acc.length; k++) acc[k] += row[k] * wy;
    }
    const norm = 1 / (sx.s * sy.s);
    for (let k = 0, o = j * w2 * 3; k < acc.length; k++, o++) {
      out[o] = encode(acc[k] * norm) * MAX16 + 0.5;
    }
  }
  return { width: w2, height: h2, data: out };
}

/** 긴 변을 `longEdge`로 맞춘 크기. 원본보다 크면 원본 그대로. */
function fitSize(width, height, longEdge) {
  const cur = Math.max(width, height);
  if (!longEdge || longEdge >= cur) return { width, height };
  const k = longEdge / cur;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

module.exports = {
  GAMMA, MAX16, SOURCE_SPACES,
  decode, encode, toWorking, toSRGB8, toCodes16, resize, fitSize,
};
