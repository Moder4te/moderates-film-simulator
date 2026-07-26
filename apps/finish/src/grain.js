/**
 * 명암별 차등 그레인 — 다이클라우드 근사.
 *
 * 실제 필름 입자는 노출량에 따라 가시성이 다르다. 완전 암부와 완전 명부에서는
 * 입자가 억제되고 중간톤에서 가장 두드러진다. 균일 노이즈로는 재현되지 않는다.
 *
 * 그리고 입자 자체가 균일한 둥근 점이 아니다. 두 가지를 더 재현한다(format.dyeClouds).
 *
 *   · **채널별 진폭** — Vision3 500T 실측 4장에서 채널차는 크기가 아니라 세기였다
 *     (청색 RMS가 녹색의 ~1.76배). 채널을 골라 각각 노이즈를 넣어 청색을 시끄럽게
 *     한다. halation이 쓰는 채널 선택 패턴과 같다.
 *   · **클럼프 옥타브** — 미세 해시 위에 큰 상관길이의 덩어리를 겹친다. 실제
 *     그레인은 단일 주파수가 아니라 광대역 밀도 요동이다.
 *
 * 그리고 블러를 크게 걸면 입자가 뭉개져 안 보인다(실측 상관길이 ~1px = 크리스프).
 * 블러 반경을 입자 px의 작은 분수로만 걸어 날카로움을 유지한다(GRAIN_BLUR).
 *
 * 구현: 50% 회색 + 노이즈 레이어를 Overlay로 올리고, Blend If(underlying)로
 * 하단 레이어의 휘도 구간을 지정한다. 마스크 채널 생성 없이 페더링까지 얻는다.
 * median·threshold 디스크립터가 미채록이라, 채록된 addNoise·gaussianBlur·
 * selectChannel만으로 근사한다.
 */

const { app, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");
const displace = require("../lib/core/optics/displace");

// Photoshop 채널 열거자. green은 "grain"이다(halation.js와 동일).
const CHANNELS = [["red", "r"], ["grain", "g"], ["blue", "b"]];
const MIN_BLUR = 0.15; // 이보다 작은 반경은 노이즈만 흐려 무의미하다.
// 입자 px 대비 블러 반경 비율. 1:1로 걸면 뭉개진다. 작게 걸어 크리스프 유지.
const GRAIN_BLUR = 0.4;

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
 * 노이즈 명령을 만든다.
 *
 * 컬러 모드 — 채널을 골라 각각 노이즈를 넣는다. 채널별 진폭(청색 시끄럽게)을 주고,
 * 동시에 채널이 독립이라 색 그레인이 된다. 끝에 RGB로 복원한다. Add Noise가 채널
 * 선택을 존중하는 것은 halation의 채널별 블러와 같은 필터 서브시스템 동작이다.
 *
 * 모노 모드 — 단일 노이즈.
 */
function noiseCommands(strength, cfg, sizing) {
  const base = noiseAmountFor(strength, sizing.amountScale);
  if (cfg.colorMode === "mono") return [ps.addNoise(base, true)];

  const { amps } = format.dyeClouds(sizing.px, cfg);
  const out = [];
  for (const [enumName, key] of CHANNELS) {
    out.push(ps.selectChannel(enumName), ps.addNoise(Math.max(1, base * amps[key]), true));
  }
  out.push(ps.selectChannel("RGB"));
  return out;
}

async function addZone(doc, label, strength, range, cfg, sizing, prefix) {
  if (strength <= 0) return;

  const [bMin, bMax, wMin, wMax] = blendRangeFor(range, cfg.feather);
  const opacity = opacityFor(strength);
  // 크리스프 유지 — 입자 px의 작은 분수만 블러. 서브픽셀이면 아예 안 건다.
  const blurPx = sizing.subPixel ? 0 : sizing.px * GRAIN_BLUR;

  // 1) 베이스 그레인 — 채널별 진폭(또는 단일) + 미세 블러.
  const cmds = [
    ps.makePixelLayer(),
    ps.renameLayer(`${prefix} · Grain ${label}`),
    ps.fillLayer("gray"),
    ...noiseCommands(strength, cfg, sizing),
  ];
  if (blurPx > MIN_BLUR) cmds.push(ps.gaussianBlur(blurPx));
  cmds.push(ps.setLayerBlend("overlay", opacity));
  cmds.push(ps.setUnderlyingBlendRange(bMin, bMax, wMin, wMax));
  await play(cmds);

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

/**
 * 디퓨전 — **해상도를 입자 크기에 묶는다.**
 *
 * 필름은 입자가 곧 표본이라 입자보다 작은 디테일은 존재할 수 없다. 우리 그레인은
 * 샤프한 베이스 위에 Overlay로 얹힐 뿐이라 서브입자 디테일(razor 엣지, 1px 선)이
 * 그대로 살아남았다(사용자 지적).
 *
 * 그래서 흐린 합성본을 얹어 **입자보다 고운 디테일을 지운다.** 두 가지가 핵심이다.
 *
 *   1. **반경 = 입자 크기** (px*1.3). 입자보다 큰 디테일(엣지)은 살고 작은 것만
 *      사라진다 — 해상도가 입자에 정확히 묶인다. 입자를 키우면 해상도가 더
 *      떨어진다. 이전엔 px*2.0 고정이라 입자와 무관했다.
 *   2. **강도가 높아야 한다.** Normal 블렌드는 아래 샤프가 (1−강도)만큼 비쳐,
 *      저강도면 서브입자 디테일이 그만큼 생존한다. 실제로 지우려면 85% 이상이어야
 *      한다(시뮬: 85%에서 1px 디테일 잔존 0.31, 100%에서 0.18).
 *
 * 그 위에 크리스프 그레인이 쌓여 "입자 해상도 + 그 위 입자"가 된다.
 *
 * stampVisible은 디스크립터 두 개다(빈 레이어 + 병합). 펼치지 않으면 배경을
 * 덮어 원본이 사라진다(ps.js 참조).
 */
async function applyDiffusion(doc, grain, sizing, prefix) {
  const amt = grain.diffusion || 0;
  if (amt <= 0) return;

  // 반경 = 입자 크기. 이보다 고운 디테일이 지워진다. 서브픽셀 입자엔 하한.
  const radius = Math.max(0.6, sizing.px * 1.3);

  await play([
    ...ps.stampVisible(),
    ps.renameLayer(`${prefix} · Diffusion`),
    ps.gaussianBlur(radius),
    ps.setLayerBlend("normal", amt),
  ]);
}

/**
 * 변위 디퓨전 — 블러 대신 픽셀을 입자 스케일로 이동시켜 서브입자 디테일을 부순다.
 *
 * 블러는 미세 선을 **흐리게** 남긴다(머리카락이 살아남는 이유). 변위는 픽셀을
 * 옮겨 그 선을 입자 스케일로 **조각낸다** — 에너지를 없애지 않고 흐트러뜨린다.
 * 필름이 미세 디테일을 확률적으로 기록/누락하는 거동에 더 가깝다(displace.js).
 *
 * batchPlay의 Diffuse 디스크립터가 미채록이라 imaging으로 직접 한다. 엔진의
 * applyLut과 같은 검증된 픽셀 왕복 패턴이다(빈 레이어 → 합성 읽기 → 변위 → 되쓰기).
 */
async function applyDisplaceDiffusion(doc, grain, sizing, prefix) {
  const amt = grain.diffusion || 0;
  if (amt <= 0) return;

  await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Diffusion`)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  const px = await imaging.getPixels({ documentID: doc.id, colorSpace: "RGB" });
  let outImage = null;
  try {
    const width = px.imageData.width;
    const height = px.imageData.height;
    const comps = px.imageData.components;
    const data = await px.imageData.getData({ chunky: true });

    // 진폭 = 입자 스케일 × 강도. 상관길이 = 입자. 균일난수라 RMS ≈ amp/√3.
    const ampPx = Math.max(0.3, sizing.px * (amt / 100) * 1.2);
    const corrPx = Math.max(1, sizing.px);
    const out = displace.displaceBuffer(data, width, height, comps, { ampPx, corrPx });

    outImage = await imaging.createImageDataFromBuffer(out, {
      width,
      height,
      components: comps,
      componentSize: data.BYTES_PER_ELEMENT === 2 ? 16 : 8,
      colorSpace: "RGB",
    });
    await imaging.putPixels({
      documentID: doc.id,
      layerID: layerId,
      targetBounds: { left: 0, top: 0, width, height },
      imageData: outImage,
    });
  } finally {
    if (outImage) outImage.dispose();
    px.imageData.dispose();
  }
}

async function apply(doc, grain, medium, prefix) {
  if (!grain.enabled) return;

  // 입자 크기는 세 존이 공유한다 — 같은 필름의 같은 유제이므로 톤에 따라 크기가
  // 달라질 이유가 없다. 톤별로 다른 것은 가시성(강도)이다.
  const m = medium || {};
  const sizing = format.grainSize(doc, m, grain.size);

  // 디퓨전이 먼저다 — 그레인은 부드러워진 이미지 위에 얹혀야 한다.
  // 두 방식: 블러(기본, 검증됨) vs 변위(실험, 미세 디테일을 더 잘 부순다).
  if (grain.diffuseDisplace) await applyDisplaceDiffusion(doc, grain, sizing, prefix);
  else await applyDiffusion(doc, grain, sizing, prefix);

  // 암부 → 중간톤 → 명부 순서로 쌓는다. 순서는 결과에 영향이 없지만
  // 레이어 패널에서 톤 순서대로 보이는 편이 읽기 쉽다.
  await addZone(doc, "Shadow", grain.shadow, grain.shadowRange, grain, sizing, prefix);
  await addZone(doc, "Midtone", grain.midtone, grain.midtoneRange, grain, sizing, prefix);
  await addZone(doc, "Highlight", grain.highlight, grain.highlightRange, grain, sizing, prefix);
}

module.exports = { apply, applyDiffusion, noiseAmountFor, blendRangeFor };
