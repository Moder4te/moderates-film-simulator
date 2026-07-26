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
const film = require("./film");
const films = require("./films");
const apply = require("./apply");

/**
 * 이전에 이 플러그인이 만든 레이어/그룹(이름이 "FilmSim"으로 시작)을 모두 제거한다.
 * 재적용 시 결과가 쌓이지 않고 전 내역에 덮어쓰도록 한다.
 *
 * 주의: 그룹의 delete()는 그룹만 해제(ungroup)하고 안의 레이어를 최상위로 꺼낸다
 * (레이어 자체는 안 지워짐). 그래서 FilmSim 이름 레이어가 없어질 때까지 반복한다
 * — 첫 회에 그룹이 풀리고, 다음 회에 꺼내진 개별 레이어가 실제로 삭제된다.
 */
async function clearFilmSimLayers(doc) {
  for (let guard = 0; guard < 12; guard++) {
    const targets = doc.layers.filter((l) => l.name.startsWith("FilmSim"));
    if (targets.length === 0) break;
    for (const layer of targets) {
      await layer.delete();
    }
  }
}

/**
 * 방금 만든 FilmSim 레이어들을 하나의 그룹("FilmSim")으로 묶는다.
 * 레이어 패널이 깔끔해지고, 그룹째 켜고 끄거나 불투명도로 전체 강도를 조절할 수 있다.
 * 그룹 이름도 "FilmSim"으로 시작하므로 다음 재적용 때 clearFilmSimLayers가 통째로
 * 제거한다.
 */
async function groupFilmSimLayers(doc) {
  const targets = doc.layers.filter((l) => l.name.startsWith("FilmSim"));
  if (targets.length < 1) return;
  // 대상 레이어를 모두 선택한 뒤 layerSection(그룹)으로 묶는다.
  const ref = targets.map((l) => ({ _ref: "layer", _id: l.id }));
  await ps.play([{ _obj: "select", _target: ref, makeVisible: false }]);
  await ps.play([
    { _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" } },
    ps.renameLayer("FilmSim"),
  ]);
}

/**
 * 열려 있는 문서에 파라미터를 적용한다.
 * 호출자가 executeAsModal 안에 있어야 한다 (모달 중첩 방지).
 *
 * 시작 시 이전에 이 플러그인이 만든 레이어를 지워 재적용이 쌓이지 않고 덮어쓰게
 * 한다(단일 적용·배치 공통). 끝에 결과 레이어를 하나의 그룹으로 묶는다.
 */
async function run(doc, params) {
  const medium = params.medium || { format: "35mm", reference: "document" };
  await clearFilmSimLayers(doc);
  await applyColor(doc, params);
  await halation.apply(doc, params.halation, medium.format);
  await grain.apply(doc, params.grain, medium);
  await groupFilmSimLayers(doc);
}

/**
 * 색 단계.
 *
 * 필름이 켜져 있으면 **필름 룩 위에 사용자 색 조정을 구워 넣은 LUT 한 장**으로
 * 처리한다. 필름 스톡을 고르고 취향대로 손보는 순서를 그대로 따른 것이다.
 * 꺼져 있으면 v1 경로(Photoshop 조정 레이어)로 간다.
 *
 * 필름 엔진은 조정 레이어가 아니라 픽셀 레이어로 결과를 올린다 — Color Lookup
 * 조정 레이어에 자체 LUT을 실을 수 없다는 것이 실측으로 확인됐기 때문이다
 * (v2plan.md 부록 B). 그래서 이 단계는 아래 레이어들의 합성을 읽어 덮는다.
 */
async function applyColor(doc, params) {
  const f = params.film;
  if (!f || !f.enabled) {
    await grading.apply(params.grading);
    return;
  }
  const size = f.lutSize || 33;
  const table = film.buildForParams(params, size);
  await apply.applyLut(doc, table, size);
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
