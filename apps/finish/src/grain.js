/**
 * 명암별 차등 그레인 — 값 노이즈 다이클라우드.
 *
 * 실제 필름 입자는 노출량에 따라 가시성이 다르다. 완전 암부·명부에서 억제되고
 * 중간톤에서 가장 두드러진다. 그리고 입자 자체가 균일한 둥근 점이 아니다.
 *
 * ── 값 노이즈로 생성한다 (블러 아님) ────────────────────────────────────
 *
 * 예전엔 Add Noise(1px) + 가우시안 블러로 큰 입자를 흉내 냈다. 근본 결함이었다 —
 * **블러는 큰 blob을 못 만든다.** 반경을 키우면 대비가 같이 떨어져 mush가 되지
 * 입자가 커지지 않는다(사용자 지적). 그래서 그레인 텍스처를 JS 값 노이즈로
 * 생성한다(core/optics/grainfield). 셀을 키우면 대비를 유지한 채 blob이 실제로
 * 커진다. 채널별 진폭(청색 시끄럽게)·클럼프 옥타브도 필드에 함께 굽는다.
 *
 * 텍스처는 **세 존이 공유한다** — 필름의 그레인은 한 층이고, 톤에 따라 달라지는
 * 것은 가시성뿐이다. 한 번 생성해 Overlay + Blend If로 존별 강도·톤 마스크를 준다.
 *
 * ── 디퓨전 (해상 손실) ──────────────────────────────────────────────────
 *
 * 그레인이 얹히기 전에 이미지를 입자 해상도로 눌러 razor 엣지를 없앤다. 두 방식:
 * 블러(기본)와 확산(변위, displace.js).
 */

const { app, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");
const displace = require("../lib/core/optics/displace");
const grainfield = require("../lib/core/optics/grainfield");

function opacityFor(strength) {
  return Math.max(1, (strength / 100) * 100);
}

// blob 격자 마디를 지우는 미세 블러. 입자 px의 작은 분수라 크리스프는 유지하되,
// 대형 문서(입자 px가 커질 때) smoothstep 마디가 각져 보이는 것만 눌러준다.
// 실측: 20000px에서 0.5px가 딱 맞았고 그때 cell≈3.3 → 0.15배. 0.3px 미만은 무의미.
const GRID_SMOOTH = 0.15;
function gridSmoothFor(px) {
  const b = px * GRID_SMOOTH;
  return b >= 0.3 ? b : 0;
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

/** 문서 비트 심도. PS 16bit는 0~32768(65535 아님) — Overlay 중성은 그 절반. */
function depthOf(doc) {
  const bytes = String(doc.bitsPerChannel) === "bitDepth16" ? 2 : 1;
  const maxV = bytes === 2 ? 32768 : 255;
  return { bytes, maxV, mid: maxV / 2 };
}

/**
 * 존 하나 — 공유 그레인 버퍼를 새 레이어에 putPixels하고 Overlay + Blend If.
 * 세 존이 같은 텍스처를 쓰되 강도(불투명도)와 톤 마스크만 다르다.
 */
async function addZone(doc, label, strength, range, feather, grainBuf, dims, prefix) {
  if (strength <= 0) return;

  const [bMin, bMax, wMin, wMax] = blendRangeFor(range, feather);
  await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Grain ${label}`)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  const img = await imaging.createImageDataFromBuffer(grainBuf, {
    width: dims.width,
    height: dims.height,
    components: 3,
    componentSize: dims.bytes === 2 ? 16 : 8,
    colorSpace: "RGB",
  });
  try {
    await imaging.putPixels({
      documentID: doc.id,
      layerID: layerId,
      targetBounds: { left: 0, top: 0, width: dims.width, height: dims.height },
      imageData: img,
    });
  } finally {
    img.dispose();
  }

  // 격자 마디 완화(활성 = 방금 putPixels한 그레인 레이어) → 블렌드.
  const cmds = [];
  if (dims.gridSmooth > 0) cmds.push(ps.gaussianBlur(dims.gridSmooth));
  cmds.push(ps.setLayerBlend("overlay", opacityFor(strength)));
  cmds.push(ps.setUnderlyingBlendRange(bMin, bMax, wMin, wMax));
  await play(cmds);
}

/**
 * 디퓨전(블러) — 해상도를 입자 크기에 묶는다. 흐린 합성본을 얹어 입자보다 고운
 * 디테일을 지운다. 반경 = 입자 크기, 강도가 높아야(85%+) 실제로 지워진다.
 * stampVisible은 디스크립터 두 개다 — 펼치지 않으면 배경을 덮는다(ps.js).
 */
async function blurDiffusion(doc, grain, sizing, prefix) {
  const amt = grain.diffusion || 0;
  if (amt <= 0) return;
  const radius = Math.max(0.6, sizing.px * 1.3);
  await play([
    ...ps.stampVisible(),
    ps.renameLayer(`${prefix} · Diffusion`),
    ps.gaussianBlur(radius),
    ps.setLayerBlend("normal", amt),
  ]);
}

/**
 * 디퓨전(확산) — 블러 대신 픽셀마다 이웃을 무작위로 집어 서브입자 디테일을
 * 조각낸다. 블러는 미세 선을 흐리게 남기지만 확산은 조각낸다(displace.js).
 * 반경·셀 모두 입자 크기에서 나와 흩어짐 알갱이가 텍스처와 같은 스케일이다.
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
    const radius = Math.max(0.5, sizing.px * (amt / 100));
    const cell = sizing.px;
    const out = displace.diffuseBuffer(data, width, height, comps, { radius, cell });
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

/**
 * 디퓨전만 — 해상도를 입자 크기에 묶는 베이스 처리. **할레이션보다 먼저** 돌려야
 * 한다. stampVisible/getPixels가 합성본을 잡으므로, 할레이션이 이미 있으면 그
 * 픽셀이 디퓨전 레이어에 구워져 나중에 할레이션을 끌 수 없다(사용자 버그).
 * 파이프라인이 디퓨전 → 할레이션 → 그레인 순으로 이 함수와 applyGrain을 나눠 부른다.
 */
async function applyDiffusion(doc, grain, medium, prefix) {
  if (!grain.enabled) return;
  const sizing = format.grainSize(doc, medium || {}, grain.iso);
  if (grain.diffuseDisplace) await applyDisplaceDiffusion(doc, grain, sizing, prefix);
  else await blurDiffusion(doc, grain, sizing, prefix);
}

/**
 * 그레인 존만 — 값 노이즈 텍스처 한 벌을 세 존이 Overlay로 공유한다. 디퓨전·
 * 할레이션이 모두 얹힌 뒤 **최상단**에 온다(매체 특성).
 */
async function applyGrain(doc, grain, medium, prefix) {
  if (!grain.enabled) return;
  const sizing = format.grainSize(doc, medium || {}, grain.iso);

  const width = doc.width;
  const height = doc.height;
  const depth = depthOf(doc);
  const cloud = format.dyeClouds(sizing.px, grain);
  const amps = grain.colorMode === "rgb" ? cloud.amps : null; // 없으면 모노
  const grainBuf = grainfield.generate(width, height, 3, {
    cell: Math.max(1, sizing.px),
    mid: depth.mid,
    maxV: depth.maxV,
    amp: 0.5, // Overlay 변조 진폭. 존 불투명도가 다시 스케일한다.
    amps,
    clumpScale: cloud.clumpScale,
    seed: 1,
  });
  const dims = { width, height, bytes: depth.bytes, gridSmooth: gridSmoothFor(sizing.px) };

  await addZone(doc, "Shadow", grain.shadow, grain.shadowRange, grain.feather, grainBuf, dims, prefix);
  await addZone(doc, "Midtone", grain.midtone, grain.midtoneRange, grain.feather, grainBuf, dims, prefix);
  await addZone(doc, "Highlight", grain.highlight, grain.highlightRange, grain.feather, grainBuf, dims, prefix);
}

/**
 * 편의 래퍼 — 디퓨전 + 그레인을 한 번에. **할레이션을 끼우지 않는다.** 파이프라인은
 * 할레이션을 사이에 넣으려고 두 단계를 따로 부른다(applyDiffusion/applyGrain).
 */
async function apply(doc, grain, medium, prefix) {
  await applyDiffusion(doc, grain, medium, prefix);
  await applyGrain(doc, grain, medium, prefix);
}

module.exports = { apply, applyDiffusion, applyGrain, blendRangeFor };
