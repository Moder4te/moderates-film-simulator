/**
 * 명암별 차등 그레인.
 *
 * 실제 필름 입자는 노출량에 따라 가시성이 다르다. 완전 암부와 완전 명부에서는
 * 입자가 억제되고 중간톤에서 가장 두드러진다. 균일 노이즈로는 재현되지 않는다.
 *
 * 구현: 50% 회색 + 노이즈 레이어를 Overlay로 올리고, Blend If(underlying)로
 * 하단 레이어의 휘도 구간을 지정한다. 마스크 채널 생성 없이 페더링까지 얻는다.
 */

const ps = require("./ps");
const { play } = require("./ps");
const format = require("./format");

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

async function addZone(doc, label, strength, range, cfg, sizing) {
  if (strength <= 0) return;

  const monochromatic = cfg.colorMode === "mono";
  const [bMin, bMax, wMin, wMax] = blendRangeFor(range, cfg.feather);

  const commands = [
    ps.makePixelLayer(),
    ps.renameLayer(`FilmSim · Grain ${label}`),
    ps.fillLayer("gray"),
    ps.addNoise(noiseAmountFor(strength, sizing.amountScale), monochromatic),
  ];

  // 서브픽셀 입자는 블러를 걸지 않는다. 반경 1px 미만의 가우시안은 입자를 뭉치지
  // 못하고 노이즈만 흐리게 만든다. 대신 amount로 이미 세기를 낮춰 뒀다.
  if (!sizing.subPixel && sizing.px > 0.15) {
    commands.push(ps.gaussianBlur(sizing.px));
  }

  commands.push(ps.setLayerBlend("overlay", opacityFor(strength)));
  commands.push(ps.setUnderlyingBlendRange(bMin, bMax, wMin, wMax));

  await play(commands);
}

async function apply(doc, grain, medium) {
  if (!grain.enabled) return;

  // 입자 크기는 세 존이 공유한다 — 같은 필름의 같은 유제이므로 톤에 따라 크기가
  // 달라질 이유가 없다. 톤별로 다른 것은 가시성(강도)이다.
  const m = medium || {};
  const sizing = format.grainSize(doc, m.format, grain.size, m.reference);

  // 암부 → 중간톤 → 명부 순서로 쌓는다. 순서는 결과에 영향이 없지만
  // 레이어 패널에서 톤 순서대로 보이는 편이 읽기 쉽다.
  await addZone(doc, "Shadow", grain.shadow, grain.shadowRange, grain, sizing);
  await addZone(doc, "Midtone", grain.midtone, grain.midtoneRange, grain, sizing);
  await addZone(doc, "Highlight", grain.highlight, grain.highlightRange, grain, sizing);
}

module.exports = { apply, noiseAmountFor, blendRangeFor };
