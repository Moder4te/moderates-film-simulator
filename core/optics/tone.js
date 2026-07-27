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

/** 디더 표 길이. 2의 거듭제곱이라 나머지 연산을 비트 마스크로 대신한다. */
const DITHER_N = 1 << 16;
const DITHER_MASK = DITHER_N - 1;

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
 *
 * ⚠️ **완전 단조는 아니다.** 당김 비율이 색역을 벗어난 정도에 따라 변해서, 경계
 * 근처에서 출력이 **1레벨** 뒤집힐 수 있다(무작위 2만 조합 중 0.04%, 전부 1레벨).
 * 채널별 톤 체인 자체는 완전 단조이고 여기서만 생긴다. 대안인 하드 클립은 단조롭지만
 * **색상이 틀어진다** — 1레벨 흔들림보다 색 틀어짐이 훨씬 눈에 띄고, 8bit 출력에는
 * 어차피 ±1LSB 디더가 얹히므로 이쪽을 택했다.
 */
function fitGamut(out) {
  const r = out[0];
  const g = out[1];
  const b = out[2];
  // 범위 안이면 즉시 나간다 — 대부분의 픽셀이 여기서 끝난다. 광도 계산도 아낀다.
  if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) return;

  // 기준 광도가 범위를 벗어났으면 색을 살릴 방법이 없다. 광도부터 넣고 시작한다.
  const base = clamp01(luma(r, g, b));
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

/**
 * 색온도·틴트를 **광도 보존 채널 이득**으로 바꾼다.
 *
 * 예전엔 픽셀마다 `before/after` 광도비를 다시 곱해 밝기를 맞췄다. 그러면 이득이
 * 픽셀 색에 의존해 **채널별 LUT으로 접히지 않고**, 픽셀마다 곱셈이 더 붙는다.
 *
 * 대신 이득 자체를 `0.2126·kr + 0.7152·kg + 0.0722·kb = 1`이 되도록 정규화한다.
 * 무채색은 밝기가 **정확히** 보존되고(가중합이 1이므로), 유채색도 실측상 어긋남이
 * 무시할 수준이다. 화이트밸런스가 원래 이렇게 동작하기도 한다.
 */
function whiteBalanceGains(temp, tint) {
  let kr = (1 + temp) * (1 - tint * 0.5);
  let kg = 1 + tint;
  let kb = (1 - temp) * (1 - tint * 0.5);
  const w = 0.2126 * kr + 0.7152 * kg + 0.0722 * kb;
  if (w > 1e-6) {
    kr /= w;
    kg /= w;
    kb /= w;
  }
  return [kr, kg, kb];
}

/**
 * 채널별 톤 체인을 **1D 룩업 테이블로 굽는다.**
 *
 * 선형화 → 노출·화이트밸런스 → 재인코딩 → 흑점 → 대비 → 암부·명부까지는 전부
 * **입력 채널값에만 의존**하므로 픽셀마다 다시 계산할 이유가 없다. 입력이 정수로
 * 양자화돼 있으니(8bit 256단계, 16bit 32769단계) 그 수만큼만 미리 굽는다.
 *
 * 이걸 안 하면 픽셀마다 `Math.pow`를 6번 부른다 — 24MP에서 1억4천만 번이고
 * 실측 4.4초였다. 테이블로 접으면 안쪽 루프에 pow가 하나도 남지 않는다.
 *
 * @returns {Float32Array[]} 채널당 (maxV+1)개 항목. 값은 [0,1] 밖으로 나갈 수 있다
 *   (범위 정리는 마지막 fitGamut이 한다 — 중간에 자르면 계조가 뒤집힌다).
 */
function buildChannelLuts(k, maxV, gamma) {
  const n = maxV + 1;
  const gains = whiteBalanceGains(k.temp, k.tint);
  const expGain = Math.pow(2, k.exposure);
  const invBlack = k.black < 1 ? 1 / (1 - k.black) : 1;
  const invGamma = 1 / gamma;
  const luts = [];

  for (let c = 0; c < 3; c++) {
    const t = new Float32Array(n);
    const gain = expGain * gains[c];
    const linear = gain !== 1;
    for (let i = 0; i < n; i++) {
      let v = i / maxV;
      if (linear) {
        // 노출과 화이트밸런스만 선형광에서. 빛의 곱이라 인코딩 값에 그냥 곱하면
        // 암부가 과하게 밀린다.
        const L = Math.pow(v, gamma) * gain;
        v = Math.pow(L < 0 ? 0 : L, invGamma);
      }
      if (k.black > 0) v = (v - k.black) * invBlack;
      if (k.contrast !== 0) v = contrastCurve(v, k.contrast);
      if (k.shadows !== 0) {
        const w = 1 - v;
        v += k.shadows * w * w;
      }
      if (k.highlights !== 0) v += k.highlights * v * v;
      t[i] = v;
    }
    luts.push(t);
  }
  return luts;
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
  // 조정이 없으면 손대지 않는다. 디더는 값이 레벨 사이에 떨어질 때만 의미가 있는데,
  // 항등이면 정확히 레벨 위에 있어 잡음만 더하게 된다. 호출자도 거르지만
  // **항등은 조건 없이 성립해야 하는 성질**이라 여기서도 막는다.
  if (!hasEffect(grading)) return data.slice();

  const o = opts || {};
  const maxV = o.maxV == null ? 255 : o.maxV;
  const gamma = o.gamma == null ? 2.2 : o.gamma;
  const useDither = !!o.dither;
  const k = coefficients(grading || {});

  // 디더 값은 **미리 구워 둔다.** 픽셀마다 난수를 뽑으면 채널당 두 번씩, 24MP에서
  // 1억4천만 번이 되어 그것만으로 1초가 넘는다. 표를 훑어 쓰면 시각적으로 같고 훨씬 싸다.
  // 표 길이를 2의 거듭제곱으로 두고 채널마다 어긋난 위치에서 읽어 패턴이 안 보이게 한다.
  let dtab = null;
  if (useDither) {
    const rnd = mulberry32(o.seed == null ? 0x9e3779b9 : o.seed);
    dtab = new Float32Array(DITHER_N);
    for (let i = 0; i < DITHER_N; i++) dtab[i] = rnd() - rnd(); // TPDF: 균등난수 두 개의 차
  }

  const out = new data.constructor(data.length);
  // 채널별 톤 체인은 입력값에만 의존하므로 미리 구워 둔다. 안쪽 루프에 pow가 없다.
  const lut = buildChannelLuts(k, maxV, gamma);
  const lr = lut[0];
  const lg = lut[1];
  const lb = lut[2];
  const px = [0, 0, 0];
  const doSat = k.saturation !== 0 || k.vibrance !== 0;
  let di = 0; // 디더 표 위치. 채널마다 하나씩 전진한다

  for (let p = 0, i = 0; p < count; p++, i += comps) {
    px[0] = lr[data[i]];
    px[1] = lg[data[i + 1]];
    px[2] = lb[data[i + 2]];

    // 채도 · 바이브런스. 광도를 축으로 밀고 당긴다.
    if (doSat) {
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
    // TPDF(삼각확률분포) 디더. 양자화 오차가 신호와 상관을 잃어 계단이 잡음으로 흩어진다.
    // 양수 구간에서 `(q+0.5)|0`은 Math.round와 같고 훨씬 싸다(클램프가 음수를 먼저 걷어낸다).
    for (let c = 0; c < 3; c++) {
      const q = px[c] * maxV + (useDither ? dtab[di++ & DITHER_MASK] : 0);
      out[i + c] = q <= 0 ? 0 : q >= maxV ? maxV : (q + 0.5) | 0;
    }
    for (let c = 3; c < comps; c++) out[i + c] = data[i + c]; // 알파 등은 그대로
  }
  return out;
}

module.exports = { apply, hasEffect, coefficients, fitGamut, contrastCurve, mulberry32 };
