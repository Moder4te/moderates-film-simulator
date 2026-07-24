/**
 * 처리 파이프라인.
 *
 * 순서는 결과에 직접 영향을 준다. 아래 순서로 고정한다.
 *
 *   원본
 *    → 컬러 그레이딩 (CMYK)   색이 먼저 결정되어야 한다
 *    → 할레이션               그레이딩된 하이라이트를 기준으로 확산
 *    → 그레인                 매체 특성이므로 최상단
 *
 * 그레인을 그레이딩보다 먼저 적용하면 이후 색 보정에 노이즈가 함께 증폭되어
 * 부자연스러워진다.
 */

const ps = require("./ps");
const grading = require("./grading");
const halation = require("./halation");
const grain = require("./grain");

/**
 * 이전에 이 플러그인이 만든 레이어(이름이 "FilmSim"으로 시작)를 모두 제거한다.
 * 재적용 시 결과가 쌓이지 않고 전 내역에 덮어쓰도록 한다.
 */
async function clearFilmSimLayers(doc) {
  const targets = doc.layers.filter((l) => l.name.startsWith("FilmSim"));
  for (const layer of targets) {
    await layer.delete();
  }
}

/**
 * 열려 있는 문서에 파라미터를 적용한다.
 * 호출자가 executeAsModal 안에 있어야 한다 (모달 중첩 방지).
 *
 * 시작 시 이전에 이 플러그인이 만든 레이어를 지워 재적용이 쌓이지 않고 덮어쓰게
 * 한다(단일 적용·배치 공통).
 */
async function run(doc, params) {
  await clearFilmSimLayers(doc);
  await grading.apply(params.grading);
  await halation.apply(doc, params.halation);
  await grain.apply(doc, params.grain);
}

/** 단일 문서용 진입점. 모달 래핑과 히스토리 병합을 담당한다. */
async function applyToActiveDocument(params) {
  return ps.modal("Film Simulation 적용", async (executionContext) => {
    const doc = ps.activeDocument();
    const history = await executionContext.hostControl.suspendHistory({
      documentID: doc.id,
      name: `Film Sim: ${params.name || "Untitled"}`,
    });
    try {
      await run(doc, params);
    } finally {
      await executionContext.hostControl.resumeHistory(history);
    }
  });
}

module.exports = { run, applyToActiveDocument };
