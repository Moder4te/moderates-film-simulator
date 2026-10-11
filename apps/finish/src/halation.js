/**
 * 할레이션 — 계산은 전부 `core/optics/halation.js`(순수, 노드 검사 가능)가 하고,
 * 여기는 Photoshop 픽셀을 넣고 빼는 일만 한다. 그레이딩과 같은 왕복 패턴이다.
 *
 * 산출물은 **할레이션이 더해진 합성본 한 장**(Normal)이다. 빛의 덧셈은 선형광에서
 * 해야 하는데 PS 블렌드 모드(Add·Screen)는 감마 공간에서 섞기 때문이다. 레이어를 끄면
 * 할레이션이 사라지고 불투명도로 세기를 줄일 수 있다 — 아래(그레이딩·디퓨전)는
 * 이미 구워진 단계라 잃는 것이 없다. 그레인은 이 위에 얹힌다(pipeline.js 순서).
 *
 * 예전 PS 필터 체인(Maximum 원반 + 감마 공간 Dodge/Add, 스케일당 레이어 복제)을
 * 왜 버렸는지는 core 쪽 머리말.
 */

const { app, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");
const halation = require("../lib/core/optics/halation");
const { gammaFor } = require("./grading");

async function apply(doc, h, formatId, prefix) {
  if (!h.enabled || !(h.strength > 0)) return;

  // 포맷 배율 — 산란 거리는 필름면에서 고정이라 큰 포맷일수록 좁게 보인다(format.js)
  const radiusPx = ps.percentToPixels(doc, h.radius) * format.relativeScale(formatId);

  // 단계별 시간 — 노드 0.9초가 UXP에서 12초였다(2026-10-07). 계산인지 픽셀 왕복인지
  // 가르려고 남긴다. UDT 콘솔에 찍힌다.
  const t0 = Date.now();
  const px = await imaging.getPixels({ documentID: doc.id, colorSpace: "RGB" });
  let outImage = null;
  try {
    const width = px.imageData.width;
    const height = px.imageData.height;
    const comps = px.imageData.components;
    const data = await px.imageData.getData({ chunky: true });
    const t1 = Date.now();
    const bytes = data.BYTES_PER_ELEMENT;
    const maxV = bytes === 2 ? 32768 : 255; // PS 16bit는 0~32768

    const out = halation.apply(data, width, height, comps, {
      maxV,
      gamma: gammaFor(),
      threshold: h.threshold,
      strength: h.strength,
      radiusPx,
    });
    const t2 = Date.now();
    if (!out) return; // 문턱을 넘는 빛이 없다 — 빈 레이어를 만들지 않는다

    await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Halation`)]);
    const layerId = app.activeDocument.activeLayers[0].id;
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
    console.log(`[FilmSim Finish] 할레이션 ${width}×${height} — 읽기 ${t1 - t0}ms · 계산 ${t2 - t1}ms · 쓰기 ${Date.now() - t2}ms`);
  } finally {
    if (outImage) outImage.dispose();
    px.imageData.dispose();
  }
}

module.exports = { apply };
