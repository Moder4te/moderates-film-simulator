/**
 * 명암별 차등 그레인 — 다이클라우드 근사.
 *
 * 실제 필름 입자는 노출량에 따라 가시성이 다르다. 완전 암부와 완전 명부에서는
 * 입자가 억제되고 중간톤에서 가장 두드러진다. 균일 노이즈로는 재현되지 않는다.
 *
 * 그리고 입자 자체가 균일한 둥근 점이 아니다. 두 가지를 더 재현한다(format.dyeClouds).
 *
 *   · **채널별 크기** — 컬러 필름 유제층 3겹, 청감층 결정이 가장 크다. 컬러
 *     노이즈에 채널별 블러를 걸어 청색 그레인을 조대하게 만든다.
 *   · **클럼프 옥타브** — 미세 해시 위에 큰 상관길이의 덩어리를 겹친다. 실제
 *     그레인은 단일 주파수가 아니라 광대역 밀도 요동이다.
 *
 * 구현: 50% 회색 + 노이즈 레이어를 Overlay로 올리고, Blend If(underlying)로
 * 하단 레이어의 휘도 구간을 지정한다. 마스크 채널 생성 없이 페더링까지 얻는다.
 * median·threshold 디스크립터가 미채록이라, 채록된 addNoise·gaussianBlur·
 * selectChannel만으로 근사한다(halation이 쓰는 것과 같은 채널 선택 패턴).
 */

const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");

// Photoshop 채널 열거자. green은 "grain"이다(halation.js와 동일).
const CHANNELS = [["red", "r"], ["grain", "g"], ["blue", "b"]];
const MIN_BLUR = 0.15; // 이보다 작은 반경은 노이즈만 흐려 무의미하다.

/**
 * 강도(0~100) → Add Noise의 amount와 레이어 불투명도로 분배.
 * amount만 올리면 입자가 거칠어지기만 하므로 두 값을 함께 움직인다.
 *
 * `scale`은 서브픽셀 입자 보정이다 — 픽셀보다 고운 입자는 블러로 크기를 줄일 수
 * 없으므로 세기로 환산한다(format.js 참조).
 */
function noiseAmountFor(strength, scale) {
  return Math.max(1, (strength / 100) * 55 * (scale === undefined ? 1 : scale));
}

function opacityFor(strength) {
  return Math.max(1, (strength / 100) * 100);
}

/**
 * 존 범위 [lo, hi]와 페더 폭으로 Blend If 4개 값을 만든다.
 * 페이드 인은 lo에서 lo+feather, 페이드 아웃은 hi-feather에서 hi.
 */
function blendRangeFor([lo, hi], feather) {
  const half = Math.min(feather, Math.max(1, (hi - lo) / 2));
  const blackMin = Math.max(0, lo - half);
  const blackMax = Math.min(255, lo + half);
  const whiteMin = Math.max(0, hi - half);
  const whiteMax = Math.min(255, hi + half);
  return [blackMin, blackMax, whiteMin, whiteMax];
}

/**
 * 노이즈 레이어에 크기 특성(블러)을 입힌다.
 *
 * 컬러 모드 — 채널별 반경으로 유제층 분화를 만든다. 채널을 골라 그 채널만
 * 블러하는 것은 halation이 이미 쓰는 패턴이다. 끝에 RGB로 복원해 이후 blend·
 * range op이 합성 채널에서 동작하게 한다.
 *
 * 모노 모드 — 채널이 동일하므로 채널별 블러가 무의미하다. 단일 블러만.
 */
function shapeCommands(cfg, sizing) {
  const out = [];
  if (cfg.colorMode === "mono") {
    if (!sizing.subPixel && sizing.px > MIN_BLUR) out.push(ps.gaussianBlur(sizing.px));
    return out;
  }
  const { radii } = format.dyeClouds(sizing.px, cfg);
  let touched = false;
  for (const [enumName, key] of CHANNELS) {
    if (radii[key] > MIN_BLUR) {
      out.push(ps.selectChannel(enumName), ps.gaussianBlur(radii[key]));
      touched = true;
    }
  }
  if (touched) out.push(ps.selectChannel("RGB"));
  return out;
}

async function addZone(doc, label, strength, range, cfg, sizing, prefix) {
  if (strength <= 0) return;

  const monochromatic = cfg.colorMode === "mono";
  const [bMin, bMax, wMin, wMax] = blendRangeFor(range, cfg.feather);
  const opacity = opacityFor(strength);

  // 1) 베이스 그레인 — 채널별(또는 단일) 크기.
  await play([
    ps.makePixelLayer(),
    ps.renameLayer(`${prefix} · Grain ${label}`),
    ps.fillLayer("gray"),
    ps.addNoise(noiseAmountFor(strength, sizing.amountScale), monochromatic),
    ...shapeCommands(cfg, sizing),
    ps.setLayerBlend("overlay", opacity),
    ps.setUnderlyingBlendRange(bMin, bMax, wMin, wMax),
  ]);

  // 2) 클럼프 옥타브 — 큰 반경의 저세기 덩어리. 밀도 요동은 휘도라 모노.
  const { clumpRadius, clumpScale } = format.dyeClouds(sizing.px, cfg);
  if (clumpScale > 0 && clumpRadius >= 0.5) {
    await play([
      ps.makePixelLayer(),
      ps.renameLayer(`${prefix} · Grain ${label} Clump`),
      ps.fillLayer("gray"),
      ps.addNoise(noiseAmountFor(strength, sizing.amountScale), true),
      ps.gaussianBlur(clumpRadius),
      // 베이스보다 약하게. 덩어리는 구조를 주지 세기를 지배하지 않는다.
      ps.setLayerBlend("overlay", Math.max(1, opacity * clumpScale * 0.6)),
      ps.setUnderlyingBlendRange(bMin, bMax, wMin, wMax),
    ]);
  }
}

async function apply(doc, grain, medium, prefix) {
  if (!grain.enabled) return;

  // 입자 크기는 세 존이 공유한다 — 같은 필름의 같은 유제이므로 톤에 따라 크기가
  // 달라질 이유가 없다. 톤별로 다른 것은 가시성(강도)이다.
  const m = medium || {};
  const sizing = format.grainSize(doc, m, grain.size);

  // 암부 → 중간톤 → 명부 순서로 쌓는다. 순서는 결과에 영향이 없지만
  // 레이어 패널에서 톤 순서대로 보이는 편이 읽기 쉽다.
  await addZone(doc, "Shadow", grain.shadow, grain.shadowRange, grain, sizing, prefix);
  await addZone(doc, "Midtone", grain.midtone, grain.midtoneRange, grain, sizing, prefix);
  await addZone(doc, "Highlight", grain.highlight, grain.highlightRange, grain, sizing, prefix);
}

module.exports = { apply, noiseAmountFor, blendRangeFor };
