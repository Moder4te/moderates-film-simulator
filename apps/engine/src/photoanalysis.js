/**
 * 사진 색 분석 — UXP 어댑터.
 *
 * 활성 문서를 축소해 읽고 픽셀을 집계기에 넘긴다. **계산은 하지 않는다** —
 * 색역 판정은 `core/color/gamut`, 누적과 대표색은 `core/color/analysis`가 맡는다.
 * 여기 남는 것은 호스트에서 픽셀을 꺼내 **쓸 수 있는 형태로 맞추는 일**뿐이다.
 *
 * ── 픽셀을 맞춘다는 것 ──────────────────────────────────────────────────
 *
 * 집계기와 그 결과를 쓰는 쪽(색역 임계값, 폴백 대표색, 컬러휠의 `throughLut`)이
 * 전부 **sRGB 0~255**를 전제한다. 문서 픽셀은 그렇지 않다.
 *
 *   1. **심도** — 16bit 문서에서 `getPixels`는 0~32768을 준다(255가 아니다)
 *   2. **색공간** — 문서가 ProPhoto면 그 값을 sRGB로 옮겨야 한다
 *
 * 둘 다 빠뜨렸었고, 그래서 16bit ProPhoto 문서에서 **컬러휠 마커 6개가 전부 같은
 * 색으로 뭉쳤다.** `throughLut`이 `rgb/255`를 하는데 값이 1.0을 넘어 클램프됐기
 * 때문이다. 무채색 분류도 무너져 어두운 회색까지 whites로 들어갔다.
 *
 * 8bit sRGB 문서로만 시험하면 드러나지 않는다 — v1.2 검증이 그 조건이었다.
 * 지금은 경계 검사가 이 두 가지를 강제한다(UXP-NOTES 3.1.5).
 *
 * 비용: 픽셀 1회 순회. k-means 같은 반복 없이 가볍다.
 */

const { app, imaging, core } = require("photoshop");
const analysis = require("../lib/core/color/analysis");
const gamut = require("../lib/core/color/gamut");
const lut = require("../lib/core/color/lut");
const colorspace = require("../lib/core/color/colorspace");
const ps = require("../lib/host/ps");

const SAMPLE_WIDTH = 200; // 분석용 썸네일 가로 px

async function analyze() {
  if (!app.documents.length) return null;
  const doc = app.activeDocument;
  let result = null;

  // 문서 색공간 → sRGB 변환기. 모달 밖에서 구한다(preview.js와 같은 이유).
  const toSrgb = colorspace.displayConverter(await ps.documentProfile());

  await core.executeAsModal(
    async (ctx) => {
      // 격리: FilmSim 레이어를 숨겨 '깨끗한 원본'만 읽는다 — 근거는 host/ps.js 참조.
      // 없으면 색을 [적용]한 뒤 재분석할 때 이미 구워진 색을 또 분석해 컬러휠
      // 기준색이 중복 적용된다(preview.js가 먼저 고쳐져 있던 것과 같은 문제).
      const px = await ps.withFilmSimHidden(ctx, doc, doc.id, "사진 분석", () =>
        // colorSpace를 RGB로 고정해 그레이스케일·CMYK 문서에서도 RGB로 받는다.
        imaging.getPixels({ documentID: doc.id, targetSize: { width: SAMPLE_WIDTH }, colorSpace: "RGB" })
      );
      try {
        const comps = px.imageData.components;
        const data = await px.imageData.getData({ chunky: true });

        const store = analysis.createStore();
        const inv = 1 / lut.maxValueFor(data); // 16bit면 1/32768, 8bit면 1/255
        const gOff = comps > 1 ? 1 : 0; // 그레이스케일은 단일 채널을 3채널로 복제
        const bOff = comps > 2 ? 2 : 0;
        const srgb = [0, 0, 0];

        for (let i = 0; i < data.length; i += comps) {
          toSrgb(data[i] * inv, data[i + gOff] * inv, data[i + bOff] * inv, srgb);
          store.add(srgb[0] * 255, srgb[1] * 255, srgb[2] * 255);
        }

        result = store.result();
      } finally {
        px.imageData.dispose();
      }
    },
    { commandName: "사진 색 분석" }
  );

  return result;
}

module.exports = {
  analyze,
  ALL_RANGES: gamut.ALL_RANGES,
  CHROMA_BANDS: gamut.CHROMA_BANDS,
};
