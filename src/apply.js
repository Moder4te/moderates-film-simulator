/**
 * LUT 색 적용 — 합성 픽셀을 읽어 LUT을 먹이고 새 픽셀 레이어로 되돌린다.
 *
 * 왜 조정 레이어가 아닌가: Photoshop의 Color Lookup 조정 레이어에 우리가 만든
 * LUT을 실을 방법이 없다. batchPlay descriptor가 바이너리(LUT 테이블)를 나르지
 * 못하고, 경로만 줘도 Photoshop이 파일을 읽지 않는다. Photoshop 자신의 내장
 * .cube 경로로도 동일하게 실패하는 것을 대조 실험으로 확인했다.
 * 자세한 실측 기록은 v2plan.md 부록 B에 있다.
 *
 * 성능은 문제되지 않았다 — 6336×9504(60.2MP) 16bit 문서에서 왕복 3.4초.
 * 조정 레이어 방식에 걸었던 원래 목표(5초)보다 오히려 빠르다.
 *
 * 호출자가 executeAsModal 안에 있어야 한다.
 */

const { app, action, imaging } = require("photoshop");
const ps = require("./ps");
const lut = require("./lut");

const LAYER_NAME = "FilmSim · Color";

/**
 * 문서가 v2 파이프라인의 전제를 만족하는지 본다.
 * 막지는 않고 경고만 돌려준다 — 8bit 문서도 동작은 한다.
 */
function validate(doc) {
  const warnings = [];
  const depth = String(doc.bitsPerChannel);
  if (depth !== "bitDepth16") {
    warnings.push(
      `문서가 ${depth}입니다. 16비트를 권장합니다 (이미지 → 모드 → 16비트/채널).`
    );
  }
  if (String(doc.mode) !== "RGBColorMode") {
    warnings.push(`문서 색상 모드가 ${doc.mode}입니다. RGB가 필요합니다.`);
  }
  return warnings;
}

/**
 * 합성 픽셀에 LUT을 적용해 새 레이어로 올린다.
 *
 * @param {object} doc    활성 문서
 * @param {Float32Array} table  LUT (size³ × 3)
 * @param {number} size   격자 크기
 */
async function applyLut(doc, table, size) {
  // 레이어를 먼저 만든다. getPixels가 합성을 읽으므로, 빈 레이어가 위에 있어도
  // 읽는 내용은 달라지지 않는다.
  await ps.play([ps.makePixelLayer(), ps.renameLayer(LAYER_NAME)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  const px = await imaging.getPixels({ documentID: doc.id, colorSpace: "RGB" });
  let outImage = null;
  try {
    const width = px.imageData.width;
    const height = px.imageData.height;
    const comps = px.imageData.components;
    const data = await px.imageData.getData({ chunky: true });

    const out = lut.applyToBuffer(data, comps, width * height, table, size);

    outImage = await imaging.createImageDataFromBuffer(out, {
      width,
      height,
      components: 3,
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

module.exports = { applyLut, validate, LAYER_NAME };
