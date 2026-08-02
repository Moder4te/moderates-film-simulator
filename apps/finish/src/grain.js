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
 * 텍스처는 **세 존이 공유한다**(지금은 — ZONE_SCALE이 항등 1인 동안) — 필름의
 * 그레인은 한 층이고, 톤에 따라 달라지는 것은 가시성과(밀도가 오르면 굵어지는)
 * 클럼프 크기다. 한 번 생성해 Overlay + Blend If로 존별 강도·톤 마스크를 주고,
 * 명부 존은 레이어를 확대해 굵은 덩어리를 흉내낸다(G3, 지금은 손잡이만 — 확대
 * 배율은 실측 전까지 1로 고정돼 눈에 보이는 차이가 없다).
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
const { zoneRanges } = require("../lib/core/optics/grainzones");

/**
 * 그레인 강도(0~100) → 레이어 불투명도(%).
 *
 * 그대로 넘긴다. 하한 1%만 둔다 — 0%면 Photoshop이 레이어를 아예 안 그려, 강도를
 * 0으로 두고 왜 그레인 레이어만 남는지 헷갈리는 상태가 된다.
 *
 * 예전에는 `(strength / 100) * 100`이라고 적혀 있었다. "무언가 환산이 일어난다"고
 * 읽히지만 실제로는 항등이다 — **정확히 항등은 아니다.** 나누고 곱하는 사이에
 * 부동소수점 오차가 남아 정수 8개(7·14·28·29·55·…)에서 `28.999999999999996` 같은
 * 값이 나왔다. Photoshop이 불투명도를 내부 0~255로 양자화하므로 0~100 전 구간에서
 * 결과가 달라지는 지점은 **없고**(확인함), 그래도 사용자가 고른 값을 그대로 넘기는
 * 지금 쪽이 맞다.
 */
function opacityFor(strength) {
  return Math.max(1, strength);
}

// blob 격자 마디를 지우는 미세 블러(px). 굵은 입자일수록 smoothstep 마디가 각져
// 보여 더 눌러야 한다. 감도에 묶는다 — 감도가 곧 입자 크기이므로.
//
// 사용자 실측 튜닝: ISO 3200 → 2px, 1600 → 1.5px, 800 → 1px, 400 이하 → 0.
// 400 위로 한 스톱마다 +0.5px = `0.5 + 0.5·log2(ISO/400)`.
function gridSmoothForIso(iso) {
  if (iso <= 400) return 0;
  return 0.5 + 0.5 * Math.log2(iso / 400);
}

// 위 값은 장축 9000px에서 맞춘 것이다. 마디 크기는 cell px에 비례하고 cell은
// longEdge에 비례하므로, 저해상도면 블러도 같은 비율로 줄여야 한다. 안 줄이면
// 작아진 입자에 고정 블러가 과해 뭉갠다(저해상도 출력 mush). 고해상도면 커진다.
const GRID_SMOOTH_REF_EDGE = 9000;
function gridSmoothPx(iso, longEdge) {
  return gridSmoothForIso(iso) * ((longEdge || GRID_SMOOTH_REF_EDGE) / GRID_SMOOTH_REF_EDGE);
}

// 명부 Overlay 이득 보상(G4) — Overlay의 2·min(b,1−b) 이득이 L>128에서
// Weber 상대대비를 무너뜨린다(L=212에서 10%, 240에서 3%). 암부는 이미 완벽하고
// (L<128에서 상대대비 50% 상수) 보상하면 오히려 과해지므로 명부에만 건다.
// 전량 보상(2.9)은 슬라이더가 34%에서 100%에 닿아 상단을 죽이므로 **부분
// 보상**만 한다 — 차별화 지수 25%(현행) → 64%(교차점+이 보상), 육안 조정 대상.
// ⚠️ G3(존별 클럼프 크기)를 실측으로 채운 뒤 다시 맞출 가능성이 크다 — 크기가
// 굵어지면 같은 진폭도 더 세 보인다(docs/PLAN-GRAIN-2026-08-02.md G4).
const HIGHLIGHT_GAIN = 2.2;

// 존별 레이어 확대 배율(G3) — 명부일수록 현상 입자가 겹쳐 클럼프가 굵어지는
// 것을 "필드를 다시 굽지 않고 레이어를 확대"해 흉내낸다(대비를 보존하는
// 방법이라 블러보다 낫다는 것은 합성 자기검증으로 확인됨). **실측(M1)으로
// 채우기 전까지 전부 항등(1) — 눈에 보이는 차이는 없다.** MID_GRAY_OFFSET과
// 같은 패턴: 정답 없이 손잡이만 먼저 만든다.
const ZONE_SCALE = { shadow: 1, midtone: 1, highlight: 1 };

/** 문서 비트 심도. PS 16bit는 0~32768(65535 아님) — Overlay 중성은 그 절반. */
function depthOf(doc) {
  const bytes = String(doc.bitsPerChannel) === "bitDepth16" ? 2 : 1;
  const maxV = bytes === 2 ? 32768 : 255;
  return { bytes, maxV, mid: maxV / 2 };
}

/**
 * 존 하나 — 공유 그레인 **imageData**를 새 레이어에 putPixels하고 Overlay + Blend If.
 * 세 존이 같은 텍스처를 쓰되 강도(불투명도)·톤 마스크·(명부는) 확대 배율만 다르다.
 *
 * imageData는 호출자가 **한 번만 만들어** 넘긴다. 존마다 새로 만들면 같은 버퍼를
 * 세 번 변환하게 되는데, 대형 문서에서 그 비용이 그대로 세 배가 된다.
 *
 * @param {number[]} blendRange Blend If 4값 [blackMin,blackMax,whiteMin,whiteMax] —
 *   `core/optics/grainzones.zoneRanges`가 만든다
 * @param {number} scale 레이어 확대 배율(1 = 항등, 확대만 한다 — 축소는 캔버스
 *   가장자리에 구멍을 낸다)
 */
async function addZone(doc, label, strength, blendRange, img, dims, prefix, scale) {
  if (strength <= 0) return;

  const [bMin, bMax, wMin, wMax] = blendRange;
  await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Grain ${label}`)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  await imaging.putPixels({
    documentID: doc.id,
    layerID: layerId,
    targetBounds: { left: 0, top: 0, width: dims.width, height: dims.height },
    imageData: img,
  });

  // 격자 마디 완화 + (있으면) 확대 + 블렌드. 순서는 확대를 먼저 해야 격자완화
  // 블러 반경이 확대된 blob 크기 기준으로 맞는다.
  const cmds = [];
  if (scale && scale > 1) cmds.push(ps.scaleLayer(scale * 100));
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
  const isRgb = grain.colorMode === "rgb";
  const amps = isRgb ? cloud.amps : null; // 없으면 모노
  const cellScale = isRgb ? cloud.cellScale : null; // G2 — 실측 전까지 항등(1,1,1)
  const grainBuf = grainfield.generate(width, height, 3, {
    cell: Math.max(1, sizing.px),
    mid: depth.mid,
    maxV: depth.maxV,
    amp: 0.5, // Overlay 변조 진폭. 존 불투명도가 다시 스케일한다.
    amps,
    cellScale,
    clumpScale: cloud.clumpScale,
    seed: 1,
  });
  const dims = { width, height, bytes: depth.bytes, gridSmooth: gridSmoothPx(grain.iso, sizing.longEdge) };

  // imageData는 **한 번만** 만들어 세 존이 나눠 쓴다. 존마다 만들면 같은 버퍼를
  // 세 번 변환하게 되고, 대형 문서에서는 그것만으로 수백 ms가 든다.
  const img = await imaging.createImageDataFromBuffer(grainBuf, {
    width,
    height,
    components: 3,
    componentSize: depth.bytes === 2 ? 16 : 8,
    colorSpace: "RGB",
  });
  try {
    // 교차점 2개(crossover1/2)에서 세 존 범위를 유도한다 — 겹침·구멍이
    // 원천적으로 불가능하고 가중치 합이 항상 1이다(G4, core/optics/grainzones).
    const ranges = zoneRanges(grain.crossover1, grain.crossover2, grain.feather);
    await addZone(doc, "Shadow", grain.shadow, ranges.shadow, img, dims, prefix, ZONE_SCALE.shadow);
    await addZone(doc, "Midtone", grain.midtone, ranges.midtone, img, dims, prefix, ZONE_SCALE.midtone);
    // 명부만 Overlay Weber 손실을 부분 보상한다(HIGHLIGHT_GAIN) — 위 주석 참고.
    await addZone(
      doc,
      "Highlight",
      Math.min(100, grain.highlight * HIGHLIGHT_GAIN),
      ranges.highlight,
      img,
      dims,
      prefix,
      ZONE_SCALE.highlight
    );
  } finally {
    img.dispose();
  }
}

/**
 * 편의 래퍼 — 디퓨전 + 그레인을 한 번에. **할레이션을 끼우지 않는다.** 파이프라인은
 * 할레이션을 사이에 넣으려고 두 단계를 따로 부른다(applyDiffusion/applyGrain).
 */
async function apply(doc, grain, medium, prefix) {
  await applyDiffusion(doc, grain, medium, prefix);
  await applyGrain(doc, grain, medium, prefix);
}

module.exports = { apply, applyDiffusion, applyGrain };
