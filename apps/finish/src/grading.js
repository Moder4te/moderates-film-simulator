/**
 * 마감 그레이딩 — 톤·색 미세 조정을 픽셀 레이어로 얹는다.
 *
 * 계산은 전부 `core/optics/tone.js`(순수)가 하고, 여기는 Photoshop 픽셀을 넣고 빼는
 * 일만 한다. 엔진의 `applyLut`과 같은 검증된 왕복 패턴이다.
 *
 * ── 왜 조정 레이어가 아니라 픽셀인가 ────────────────────────────────────
 *
 * Curves·Color Balance 조정 레이어를 쌓는 방법도 있고 v1이 그렇게 했다. 비파괴라는
 * 장점이 있지만 **8bit 문서에서 단계마다 양자화**되고 디더를 걸 수단이 없다.
 *
 * 마감의 주 입력이 8bit JPEG이라 이 차이가 크다. float으로 한 번에 계산하고 마지막에
 * 디더링해 양자화하면 띠가 실제로 사라진다(실측: 평균 띠폭 35px → 2.3px).
 * 어차피 마감의 디퓨전이 이미 파괴적이라 비파괴를 지켜도 절반만 지키는 셈이다.
 *
 * ── 파이프라인에서 제일 먼저다 ──────────────────────────────────────────
 *
 * 색을 먼저 확정하고 광학(디퓨전·할레이션·그레인)을 얹는다. 전체 아키텍처(색 → 마감)와
 * 같은 순서이고, 할레이션이 **조정된 하이라이트**에서 발생해야 자연스럽다.
 */

const { app, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const tone = require("../lib/core/optics/tone");

/**
 * 문서 인코딩 감마. 노출·색온도를 선형광에서 계산하려면 필요하다.
 * ProPhoto는 1.8, 나머지(sRGB·Adobe RGB 등)는 2.2로 근사한다.
 */
function gammaFor() {
  const profile = ps.documentProfile();
  return profile && /prophoto|rommrgb/i.test(profile) ? 1.8 : 2.2;
}

async function apply(doc, grading, prefix) {
  if (!tone.hasEffect(grading)) return;

  await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Grading`)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  const px = await imaging.getPixels({ documentID: doc.id, colorSpace: "RGB" });
  let outImage = null;
  try {
    const width = px.imageData.width;
    const height = px.imageData.height;
    const comps = px.imageData.components;
    const data = await px.imageData.getData({ chunky: true });

    // PS 16bit는 0~32768이다(65535가 아니다). 심도는 버퍼 타입에서 판별한다.
    const bytes = data.BYTES_PER_ELEMENT;
    const maxV = bytes === 2 ? 32768 : 255;

    const out = tone.apply(data, comps, width * height, {
      maxV,
      gamma: gammaFor(),
      // 디더는 8bit에서만 의미가 있다. 16bit는 이미 충분히 촘촘하다.
      dither: maxV === 255,
    }, grading);

    outImage = await imaging.createImageDataFromBuffer(out, {
      width,
      height,
      components: comps,
      componentSize: bytes === 2 ? 16 : 8,
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

module.exports = { apply };
