/**
 * 그레이딩 파이프라인의 JS 근사 시뮬레이션.
 *
 * 패널 안의 색 팔레트 미리보기에 쓴다. Photoshop 왕복 없이 RGB 색 하나에
 * curve → crosstalk → selective color 순서로 grading.js와 동일한 순서를 적용한다.
 *
 * 정확도:
 *   - 크로스토크는 3x3 매트릭스 곱이라 Channel Mixer와 사실상 동일하다.
 *   - curve(토우/숄더/게인)는 컨트롤 포인트를 단조 3차(pchip)로 보간한 근사다.
 *   - selective color는 Photoshop 내부 알고리즘이 비공개라 색역 판정 기반 근사다.
 *     방향성(어느 색이 어느 쪽으로 움직이는지)은 맞지만 픽셀 단위 일치는 아니다.
 *
 * 즉 팔레트는 "이 파라미터가 색을 어느 방향으로 미는가"를 직관적으로 보여주는
 * 용도이고, 정확한 결과는 프록시 미리보기나 실제 적용으로 확인한다.
 */

const curve = require("./curve");

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function clampUnit(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 톤 곡선 보간 — smoothstep에서 **단조 3차(pchip)로 교체**했다.
 *
 * smoothstep은 끝점에서 기울기가 0이다. 그래서 토우 곡선의 흑점(입력 0)에서
 * 기울기가 0.022로 거의 평평한 **셸프**가 생겨, 입력 0~5레벨이 같은 값으로
 * 뭉쳤다. 채널마다 이 셸프에 실리므로, 색이 있는 딥섀도가 흑점 근처에서 균일한
 * 틴트로 물들었다 — "블랙포인트 색 이상"의 정체였다(TODO 0-13).
 *
 * pchip은 같은 컨트롤포인트를 지나면서 흑점 기울기 0.944(항등 1.0에 근접),
 * 셸프 폭 1.25레벨, 2차 차분 0.0008(smoothstep의 1/115)로 매끄럽다. 엔진이
 * 필름 특성곡선에 이미 쓰는 보간이라 새 의존성도 아니다.
 *
 * 곡선을 **파라미터로 캐시**한다. `applyGrading`은 격자점마다 불리므로(bake에서
 * 35937회) pchip을 매번 만들면 그만큼 느려진다. 한 번의 bake 동안 grading이
 * 고정이라 캐시는 사실상 build-once로 동작한다.
 */
let toeCache = { key: null, fn: null };
function toeShoulderCurve(toe, shoulder) {
  const key = toe + "|" + shoulder;
  if (toeCache.key === key) return toeCache.fn;
  const toeLift = (toe / 100) * 24;
  const shoulderDrop = (shoulder / 100) * 24;
  const fn = curve.pchip([
    [0, toeLift],
    [64, 64 + toeLift * 0.5],
    [192, 192 - shoulderDrop * 0.5],
    [255, 255 - shoulderDrop],
  ]);
  toeCache = { key, fn };
  return fn;
}

const gainCache = new Map();
function gainCurve(gain) {
  if (gain === 1) return null; // 항등 — 곡선 불필요
  let fn = gainCache.get(gain);
  if (!fn) {
    if (gainCache.size > 32) gainCache.clear(); // 슬라이더가 값을 계속 바꿔도 무한정 안 쌓이게
    fn = curve.pchip([[0, 0], [128, clamp255(128 * gain)], [255, 255]]);
    gainCache.set(gain, fn);
  }
  return fn;
}

function applyCurves(rgb, grading) {
  const { toe, shoulder, channelGain } = grading;
  let [r, g, b] = rgb;

  if (toe !== 0 || shoulder !== 0) {
    const f = toeShoulderCurve(toe, shoulder);
    r = f(r);
    g = f(g);
    b = f(b);
  }

  const gr = gainCurve(channelGain.r);
  const gg = gainCurve(channelGain.g);
  const gb = gainCurve(channelGain.b);
  if (gr) r = gr(r);
  if (gg) g = gg(g);
  if (gb) b = gb(b);

  return [r, g, b];
}

function applyCrosstalk(rgb, crosstalk) {
  if (!crosstalk || !crosstalk.enabled) return rgb;
  const m = crosstalk.matrix;
  const [r, g, b] = rgb;
  return [
    (m[0][0] * r + m[0][1] * g + m[0][2] * b) / 100,
    (m[1][0] * r + m[1][1] * g + m[1][2] * b) / 100,
    (m[2][0] * r + m[2][1] * g + m[2][2] * b) / 100,
  ];
}

function rgbToHSL(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const sat = max === 0 ? 0 : d / max;
  return { h, sat, lum: (max + min) / 2 };
}

const CHROMA_BANDS = [
  { name: "reds", hue: 0 },
  { name: "yellows", hue: 60 },
  { name: "greens", hue: 120 },
  { name: "cyans", hue: 180 },
  { name: "blues", hue: 240 },
  { name: "magentas", hue: 300 },
];

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Selective Color 근사. CMY 잉크 델타를 색역별 가중치로 누적한 뒤 RGB에 반영한다.
 * 잉크 증가 = 해당 채널 감소 (C↓R, M↓G, Y↓B, K는 전 채널 감소).
 */
function applySelectiveColor(rgb, grading) {
  const sc = grading.selectiveColor;
  let [r, g, b] = rgb;
  const { h, sat, lum } = rgbToHSL(r, g, b);

  let dc = 0;
  let dm = 0;
  let dy = 0;

  // 유채색 색역: 인접 두 밴드에 hue 거리로 가중, 채도에 비례.
  for (const band of CHROMA_BANDS) {
    const dist = hueDist(h, band.hue);
    if (dist >= 60) continue;
    const w = (1 - dist / 60) * sat;
    if (w <= 0) continue;
    const adj = sc[band.name];
    dc += (adj.c + adj.k) * w;
    dm += (adj.m + adj.k) * w;
    dy += (adj.y + adj.k) * w;
  }

  // 무채색 색역: 채도가 낮을수록 강하게, 밝기로 blacks/neutrals/whites 배분.
  const achroma = 1 - sat;
  const blacksW = achroma * clampUnit((0.5 - lum) / 0.5);
  const whitesW = achroma * clampUnit((lum - 0.5) / 0.5);
  const neutralsW = achroma * (1 - Math.abs(lum - 0.5) * 2) * 0.8; // 중간톤 종형
  const addBand = (adj, w) => {
    if (w <= 0) return;
    dc += (adj.c + adj.k) * w;
    dm += (adj.m + adj.k) * w;
    dy += (adj.y + adj.k) * w;
  };
  addBand(sc.blacks, blacksW);
  addBand(sc.whites, whitesW);
  addBand(sc.neutrals, neutralsW);

  // -100..100 조정을 채널 변화로 매핑.
  const gain = 2.0;
  if (grading.method === "relative") {
    const cInk = (255 - r) / 255;
    const mInk = (255 - g) / 255;
    const yInk = (255 - b) / 255;
    r -= dc * gain * cInk;
    g -= dm * gain * mInk;
    b -= dy * gain * yInk;
  } else {
    r -= dc * gain;
    g -= dm * gain;
    b -= dy * gain;
  }

  return [r, g, b];
}

/**
 * RGB 색 하나에 grading을 근사 적용한다. 입력/출력 모두 [r,g,b] 0~255.
 */
function applyGrading(rgb, grading) {
  if (!grading || !grading.enabled) return rgb.map(clamp255);
  let out = rgb.slice();
  out = applyCurves(out, grading);
  out = applyCrosstalk(out, grading.crosstalk);
  out = applySelectiveColor(out, grading);
  return out.map(clamp255);
}

module.exports = { applyGrading };
