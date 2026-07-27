/**
 * 마감 그레이딩 — 톤·색 보정 (순수 계산).
 *
 * 이미 현상된 파일(보통 8bit JPEG)에 얹는 **미세 조정**이다. 필름 색을 정하는 것은
 * 엔진의 일이고(`core/color`), 여기는 그 결과물을 조금 손보는 자리다. 그래서 색역별
 * CMY 같은 정밀 조작은 넣지 않는다 — 넣으면 두 도구의 역할이 겹친다.
 *
 * ── 8bit 밴딩을 어떻게 다루는가 ─────────────────────────────────────────
 *
 * 8bit는 채널당 256단계뿐이라 곡선을 세게 걸면 계단이 보인다. 실측하면 중간 강도
 * 조정에서 **최대 2~4레벨의 계단**이 생긴다(감마 0.75 밝히기가 최악).
 *
 * 근본 원인은 내부 정밀도가 아니라 **출력 양자화**다. 16bit로 올렸다 내려도 원본이
 * 8bit면 정보가 늘지 않는다. 실제로 듣는 대책은 두 가지뿐이다.
 *
 *   1. **양자화를 한 번만 한다.** 조정 레이어를 여러 장 쌓으면 합성 때마다 8bit로
 *      잘린다. 여기서는 float으로 전 단계를 계산하고 **마지막에 한 번만** 양자화한다.
 *   2. **디더링.** 양자화 직전에 TPDF 잡음을 더해 계단을 잡음으로 바꾼다. 눈에는
 *      계단보다 미세 잡음이 낫고, 어차피 그 위에 그레인이 얹힌다.
 *
 * 16bit 문서는 이미 충분히 촘촘해 디더를 걸지 않는다.
 *
 * ── 연산 공간 ───────────────────────────────────────────────────────────
 *
 * **노출과 색온도만 선형광에서** 한다. 노출은 물리적으로 빛의 곱이라 인코딩 값에
 * 그냥 곱하면 암부가 과하게 밀린다. 나머지(대비·암부/명부·채도)는 **인코딩 공간**에서
 * 하는데, Photoshop·Lightroom 슬라이더가 그렇게 동작해 사용자의 기대와 맞기 때문이다.
 *
 * 순수 함수다. Photoshop imaging은 호출자가 픽셀을 넣고 뺀다.
 */

/** 결정적 PRNG (mulberry32). 디더를 재현 가능하게 하려면 시드를 준다. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 표시 광도. 감마 공간 가중 평균이라 엄밀한 광도는 아니지만 채도 기준으로 충분하다. */
function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 색역 맞춤 — 범위를 벗어난 색을 **회색 쪽으로 당겨** 넣는다.
 *
 * 채널마다 따로 자르면 RGB 비율이 깨져 **색상 자체가 바뀐다.** 엔진에서 같은 문제를
 * 겪었다(`core/color/scanner.js`의 fitGamut). 비율을 유지하면 색상이 보존되고
 * 대신 채도가 준다 — 그쪽이 훨씬 덜 눈에 띈다.
 *
 * 상한과 **하한 양쪽**을 본다. 채도 연산은 어두운 포화색에서 음수를 만드는데,
 * 엔진 실측에서 클램프의 대부분이 하한이었다.
 */
function fitGamut(out) {
  const L = luma(out[0], out[1], out[2]);
  let hi = 0;
  let lo = 0;
  for (let c = 0; c < 3; c++) {
    if (out[c] > 1 + hi) hi = out[c] - 1;
    if (out[c] < -lo) lo = -out[c];
  }
  if (hi <= 0 && lo <= 0) return;

  // 기준 광도가 범위를 벗어났으면 색을 살릴 방법이 없다. 광도부터 넣고 시작한다.
  const base = clamp01(L);
  // 회색(base) 쪽으로 당길 비율. 상·하한 중 더 심한 쪽에 맞춘다.
  let t = 0;
  for (let c = 0; c < 3; c++) {
    const d = out[c] - base;
    if (d === 0) continue;
    if (out[c] > 1) t = Math.max(t, (out[c] - 1) / d);
    if (out[c] < 0) t = Math.max(t, (out[c] - 0) / d);
  }
  if (t <= 0) t = 0;
  if (t > 1) t = 1;
  for (let c = 0; c < 3; c++) {
    out[c] = clamp01(base + (out[c] - base) * (1 - t));
  }
}

/**
 * 대비 S커브. 엔드포인트를 보존하고 **범위 밖에서도 단조롭다.** c는 -1~1.
 *
 * smoothstep은 [0,1] 밖에서 뒤집힌다(v=1.2에서 0.864로 **내려간다**). 그래서 곡선은
 * 클램프한 값에만 먹이고 **초과분은 그대로 더해 보존한다.**
 *
 * 초과분을 버리면(단순 클램프) 인공 평탄부가 생기는데, 뒤에 오는 채도 연산이
 * `L + (v−L)·s` 꼴이라 v가 평평한데 광도 L만 계속 오르면 **기울기가 음수가 되어
 * 계조가 뒤집힌다.** 실제로 그렇게 만들었다가 실측에서 잡았다.
 */
function contrastCurve(v, c) {
  if (c === 0) return v;
  const t = clamp01(v);
  const excess = v - t; // 범위 밖 성분. 마지막에 되돌려 준다
  let shaped;
  if (c > 0) {
    const s = t * t * (3 - 2 * t); // smoothstep — 중앙을 세우고 양끝은 그대로
    shaped = t + (s - t) * c;
  } else {
    const flat = 0.5 + (t - 0.5) * 0.5; // 대비를 절반으로
    shaped = t + (flat - t) * -c;
  }
  return shaped + excess;
}

/**
 * 파라미터를 계산용 계수로 정규화한다. 슬라이더 값과 내부 수치를 한곳에서 잇는다.
 *
 * 상한은 **8bit에서 디더로도 복구 불가한 영역 직전**에서 끊었다. 그 위로 올리면
 * 조정이 아니라 파괴가 된다.
 */
function coefficients(g) {
  const n = (v, lim) => ((v == null ? 0 : v) / 100) * lim;
  return {
    exposure: (g.exposure == null ? 0 : g.exposure), // 스톱. 직접 쓴다
    black: n(g.black, 0.25), // 0~50 → 0~0.125
    contrast: n(g.contrast, 1.0), // ±50 → ±0.5
    // 암부·명부 리프트. 0.25를 넘기면 가중식의 도함수가 음수가 되어 계조가 뒤집힌다.
    shadows: n(g.shadows, 0.25),
    highlights: n(g.highlights, 0.25),
    temp: n(g.temp, 0.18), // ±100 → ±0.18 채널 이득
    tint: n(g.tint, 0.18),
    saturation: n(g.saturation, 1.0), // ±100 → 채도 0~2배
    vibrance: n(g.vibrance, 1.0),
  };
}

/** 조정이 하나라도 걸려 있는가. 전부 0이면 호출자가 통째로 건너뛴다. */
function hasEffect(g) {
  if (!g || g.enabled === false) return false;
  const k = ["exposure", "contrast", "shadows", "highlights", "black", "temp", "tint", "saturation", "vibrance"];
  return k.some((key) => (g[key] || 0) !== 0);
}

/**
 * 픽셀 버퍼에 그레이딩을 적용한다.
 *
 * @param {Uint8Array|Uint16Array} data  인터리브 픽셀 (읽기 전용)
 * @param {number} comps  채널 수 (알파가 있으면 4)
 * @param {number} count  픽셀 수
 * @param {object} opts
 *   maxV    최대값. 8bit 255, PS 16bit 32768
 *   gamma   인코딩 감마 (sRGB 계열 2.2, ProPhoto 1.8)
 *   dither  8bit 출력에서만 true
 *   seed    디더 시드 (없으면 Math.random)
 * @param {object} grading  슬라이더 파라미터
 * @returns {Uint8Array|Uint16Array} 새 버퍼 (입력과 같은 타입)
 */
function apply(data, comps, count, opts, grading) {
  const o = opts || {};
  const maxV = o.maxV == null ? 255 : o.maxV;
  const gamma = o.gamma == null ? 2.2 : o.gamma;
  const useDither = !!o.dither;
  const rand = o.seed != null ? mulberry32(o.seed) : Math.random;
  const k = coefficients(grading || {});

  const out = new data.constructor(data.length);
  const inv = 1 / maxV;
  const expGain = Math.pow(2, k.exposure);
  const invBlack = k.black < 1 ? 1 / (1 - k.black) : 1;
  const px = [0, 0, 0];

  for (let p = 0, i = 0; p < count; p++, i += comps) {
    px[0] = data[i] * inv;
    px[1] = data[i + 1] * inv;
    px[2] = data[i + 2] * inv;

    // ── 선형광 단계 — 노출과 색온도 ─────────────────────────────────────
    if (k.exposure !== 0 || k.temp !== 0 || k.tint !== 0) {
      let r = Math.pow(px[0], gamma);
      let g = Math.pow(px[1], gamma);
      let b = Math.pow(px[2], gamma);

      if (k.exposure !== 0) {
        r *= expGain;
        g *= expGain;
        b *= expGain;
      }

      if (k.temp !== 0 || k.tint !== 0) {
        // 색온도는 R↔B를 반대로, 틴트는 G를 R·B 반대로 민다.
        // 그대로 두면 밝기가 함께 변하므로 **광도를 다시 맞춘다** — 색만 돌고
        // 노출은 노출 슬라이더가 담당하게 한다.
        const before = luma(r, g, b);
        r *= 1 + k.temp;
        b *= 1 - k.temp;
        g *= 1 + k.tint;
        r *= 1 - k.tint * 0.5;
        b *= 1 - k.tint * 0.5;
        const after = luma(r, g, b);
        if (after > 1e-6) {
          const fix = before / after;
          r *= fix;
          g *= fix;
          b *= fix;
        }
      }

      const ig = 1 / gamma;
      px[0] = Math.pow(r < 0 ? 0 : r, ig);
      px[1] = Math.pow(g < 0 ? 0 : g, ig);
      px[2] = Math.pow(b < 0 ? 0 : b, ig);
    }

    // ── 인코딩 공간 단계 ────────────────────────────────────────────────
    for (let c = 0; c < 3; c++) {
      let v = px[c];
      if (k.black > 0) v = (v - k.black) * invBlack;
      // ⚠️ 여기서 클램프하지 않는다. 범위 밖 성분을 살려 둬야 뒤의 채도 연산에서
      // 계조가 뒤집히지 않는다(contrastCurve 주석 참조). 클램프는 fitGamut이 맡는다.
      if (k.contrast !== 0) v = contrastCurve(v, k.contrast);
      if (k.shadows !== 0) {
        const w = 1 - v;
        v += k.shadows * w * w;
      }
      if (k.highlights !== 0) v += k.highlights * v * v;
      px[c] = v;
    }

    // 채도 · 바이브런스. 광도를 축으로 밀고 당긴다.
    if (k.saturation !== 0 || k.vibrance !== 0) {
      const L = luma(px[0], px[1], px[2]);
      let s = 1 + k.saturation;
      if (k.vibrance !== 0) {
        // 이미 포화한 색은 덜 건드린다 — 피부톤이 먼저 망가지는 것을 막는다.
        const mx = Math.max(px[0], px[1], px[2]);
        const mn = Math.min(px[0], px[1], px[2]);
        const local = mx > 1e-6 ? (mx - mn) / mx : 0;
        s += k.vibrance * (1 - clamp01(local));
      }
      px[0] = L + (px[0] - L) * s;
      px[1] = L + (px[1] - L) * s;
      px[2] = L + (px[2] - L) * s;
    }

    // 하드 클립 대신 회색 쪽으로 당겨 색상을 보존한다.
    fitGamut(px);

    // ── 출력 — 디더 후 한 번만 양자화 ───────────────────────────────────
    for (let c = 0; c < 3; c++) {
      let q = px[c] * maxV;
      // TPDF(삼각확률분포) 디더. 균등난수 두 개의 차라 ±1LSB 삼각분포가 되고,
      // 양자화 오차가 신호와 상관을 잃어 계단이 잡음으로 흩어진다.
      if (useDither) q += rand() - rand();
      q = Math.round(q);
      out[i + c] = q < 0 ? 0 : q > maxV ? maxV : q;
    }
    for (let c = 3; c < comps; c++) out[i + c] = data[i + c]; // 알파 등은 그대로
  }
  return out;
}

module.exports = { apply, hasEffect, coefficients, fitGamut, contrastCurve, mulberry32 };
