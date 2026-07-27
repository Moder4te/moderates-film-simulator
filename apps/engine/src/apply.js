/**
 * LUT 색 적용 — 합성 픽셀을 읽어 LUT을 먹이고 새 픽셀 레이어로 되돌린다.
 *
 * 왜 조정 레이어가 아닌가: Photoshop의 Color Lookup 조정 레이어에 우리가 만든
 * LUT을 실을 방법이 없다. batchPlay descriptor가 바이너리(LUT 테이블)를 나르지
 * 못하고, 경로만 줘도 Photoshop이 파일을 읽지 않는다. Photoshop 자신의 내장
 * .cube 경로로도 동일하게 실패하는 것을 대조 실험으로 확인했다.
 * 자세한 실측 기록은 docs/archive/v2plan.md 부록 B에 있다.
 *
 * 성능은 문제되지 않았다 — 6336×9504(60.2MP) 16bit 문서에서 왕복 3.4초.
 * 조정 레이어 방식에 걸었던 원래 목표(5초)보다 오히려 빠르다.
 *
 * 호출자가 executeAsModal 안에 있어야 한다.
 */

const { app, action, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const lut = require("../lib/core/color/lut");

/** 모든 FilmSim 레이어의 공통 접두사. 색·마감 양쪽이 이걸로 시작한다. */
const FILMSIM = "FilmSim";

/** layers 트리를 재귀로 훑어 pred를 만족하는 레이어를 모은다(그룹 안까지). */
function collectLayers(layers, pred, out) {
  for (const l of layers || []) {
    if (pred(l)) out.push(l);
    const kids = l.layers;
    if (kids && kids.length) collectLayers(kids, pred, out);
  }
  return out;
}


/**
 * 문서가 전제를 만족하는지 본다. 막지는 않고 경고만 돌려준다.
 *
 * **필름 엔진이 꺼져 있으면 비트 심도를 경고하지 않는다.** 그 상태는 마감 모드,
 * 즉 이미 색이 정해진 JPEG에 할레이션·그레인·약간의 보정을 얹는 작업이고,
 * 8bit는 그 경로의 정상적인 입력이다(v2plan 1.5의 도구 이분화). 정상 입력에
 * 경고를 띄우면 진짜 경고를 무시하게 만든다.
 *
 * @param {object} doc
 * @param {object} [params]  없으면 필름 엔진이 켜진 것으로 본다
 */
function validate(doc, params) {
  const warnings = [];
  const filmOn = !params || !params.film || params.film.enabled !== false;
  const depth = String(doc.bitsPerChannel);

  if (filmOn && depth !== "bitDepth16") {
    warnings.push(
      `필름 엔진은 16비트를 전제로 합니다. 문서가 ${depth}입니다 ` +
        `(이미지 → 모드 → 16비트/채널). 색이 이미 정해진 파일이라면 필름을 끄고 ` +
        `마감(할레이션·그레인)만 쓰는 편이 맞습니다.`
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
 * @param {string} prefix 레이어 이름 접두사 (파이프라인이 소유권을 표시한다)
 */
async function applyLut(doc, table, size, prefix) {
  // ── 중복 방지: 다른 FilmSim 레이어를 읽기에서 격리한다 ────────────────────
  //
  // getPixels는 **합성본**을 읽는다. 색을 재적용할 때 이미 얹힌 마감(FilmSim
  // Finish — 할레이션·그레인)이 합성에 섞여 있으면, 그것까지 색 레이어에 구워진다.
  // 그러면 마감이 (구워진 색 레이어 + 살아있는 마감 그룹) 두 벌이 되어 중복된다.
  // 그래서 자기 것이 아닌 FilmSim 레이어를 잠시 숨겨 **깨끗한 원본만** 읽는다.
  //
  // ⚠️ 한계: 마감의 **디퓨전 레이어는 그 시점 합성본을 구운 파괴적 스탬프**다.
  // 마감을 먼저 얹은 뒤 색을 적용하면 그 스탬프된 픽셀은 이미 확정돼 되돌릴 수
  // 없다 — 격리로 중복은 막아도, 디퓨전에 구워진 원본색까지 새로 칠하지는 못한다.
  // 올바른 순서는 색 → 마감이다(README 현재 한계). 설계상 남겨둔 한계점.
  const foreign = collectLayers(
    app.activeDocument.layers,
    (l) => l.name && l.name.startsWith(FILMSIM) && !l.name.startsWith(prefix),
    []
  );
  const toRestore = [];
  for (const l of foreign) {
    if (l.visible) { l.visible = false; toRestore.push(l); }
  }

  try {
    await ps.play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Color`)]);
    const colorLayer = app.activeDocument.activeLayers[0];
    const layerId = colorLayer.id;

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

    // 색 레이어는 마감 **아래**에 놓여야 한다(색 → 마감 순서). 방금 맨 위에
    // 만들었으니, 마감(foreign) 중 가장 아래 레이어 밑으로 내린다. 이동이
    // 실패해도 중복은 이미 막혔으므로 치명적이지 않다(위치만 어긋난다).
    if (foreign.length) {
      try {
        const anchor = foreign[foreign.length - 1];
        await colorLayer.move(anchor, "placeAfter");
      } catch (e) {
        /* 위치 조정 실패는 무시 — 중복 자체는 격리로 이미 해결 */
      }
    }
  } finally {
    // 숨겼던 마감 레이어 가시성 복원. 예외가 나도 반드시 되돌린다.
    for (const l of toRestore) {
      try { l.visible = true; } catch (e) { /* 이미 지워진 참조 등 */ }
    }
  }
}

module.exports = { applyLut, validate };
