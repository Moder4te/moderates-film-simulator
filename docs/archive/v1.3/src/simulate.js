/**
 * 그레이딩 파이프라인의 JS 근사 시뮬레이션.
 *
 * 패널 안의 색 팔레트 미리보기에 쓴다. Photoshop 왕복 없이 RGB 색 하나에
 * curve → crosstalk → selective color 순서로 grading.js와 동일한 순서를 적용한다.
 *
 * 정확도:
 *   - 크로스토크는 3x3 매트릭스 곱이라 Channel Mixer와 사실상 동일하다.
 *   - curve(토우/숄더/게인)는 컨트롤 포인트를 smoothstep으로 보간한 근사다.
 *   - selective color는 Photoshop 내부 알고리즘이 비공개라 색역 판정 기반 근사다.
 *     방향성(어느 색이 어느 쪽으로 움직이는지)은 맞지만 픽셀 단위 일치는 아니다.
 *
 * 즉 팔레트는 "이 파라미터가 색을 어느 방향으로 미는가"를 직관적으로 보여주는
 * 용도이고, 정확한 결과는 프록시 미리보기나 실제 적용으로 확인한다.
 */

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function clampUnit(v) {
  return Math.max(0, Math.min(1, v));
}

/** 컨트롤 포인트를 지나는 부드러운(smoothstep) 곡선 룩업. 입력/출력 0~255. */
function curveLookup(points, x) {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x <= x1) {
      const span = x1 - x0 || 1;
      const t = clampUnit((x - x0) / span);
      const ts = t * t * (3 - 2 * t); // smoothstep
      return y0 + (y1 - y0) * ts;
    }
  }
  return points[points.length - 1][1];
}

function applyCurves(rgb, grading) {
  const { toe, shoulder, channelGain } = grading;
  let [r, g, b] = rgb;

  if (toe !== 0 || shoulder !== 0) {
    const toeLift = (toe / 100) * 24;
    const shoulderDrop = (shoulder / 100) * 24;
    const comp = [
      [0, toeLift],
      [64, 64 + toeLift * 0.5],
      [192, 192 - shoulderDrop * 0.5],
      [255, 255 - shoulderDrop],
    ];
    r = curveLookup(comp, r);
    g = curveLookup(comp, g);
    b = curveLookup(comp, b);
  }

  const gainCurve = (gain, v) =>
    gain === 1 ? v : curveLookup([[0, 0], [128, clamp255(128 * gain)], [255, 255]], v);
  r = gainCurve(channelGain.r, r);
  g = gainCurve(channelGain.g, g);
  b = gainCurve(channelGain.b, b);

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
