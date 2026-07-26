/**
 * 엔진 파이프라인 — 색 하나만 한다.
 *
 * 필름(유제) → 스캐너 → 사용자 색 조정을 **LUT 한 장에 굽고** 픽셀 레이어로
 * 올린다. 단계가 하나뿐인 이유는 세 가지가 전부 색 변환이고, 하나의 3D LUT으로
 * 정확히 합성되기 때문이다.
 *
 * ── 레이어 이름 ────────────────────────────────────────────────────────
 *
 * `FilmSim Color`로 시작하는 것만 만들고, 재적용 시 그것만 지운다.
 * 마감 플러그인은 `FilmSim Finish`를 쓴다. **접두사를 공유하면 한쪽을 적용할 때
 * 다른 쪽 결과가 지워진다** — 두 플러그인이 같은 문서에 겹쳐 쓰는 것이 정상
 * 사용이므로 이 구분이 필수다.
 */

const ps = require("../lib/host/ps");
const film = require("../lib/core/color/film");
const apply = require("./apply");

const PREFIX = "FilmSim Color";

/**
 * 이 플러그인이 이전에 만든 레이어/그룹을 제거한다. 재적용이 쌓이지 않게 한다.
 *
 * 주의: 그룹의 delete()는 그룹만 해제(ungroup)하고 안의 레이어를 최상위로 꺼낸다.
 * 그래서 대상이 없어질 때까지 반복한다 — 첫 회에 그룹이 풀리고, 다음 회에 꺼내진
 * 개별 레이어가 실제로 삭제된다.
 */
async function clearOwnLayers(doc) {
  for (let guard = 0; guard < 12; guard++) {
    const targets = doc.layers.filter((l) => l.name.startsWith(PREFIX));
    if (targets.length === 0) break;
    for (const layer of targets) {
      await layer.delete();
    }
  }
}

/**
 * 열려 있는 문서에 색을 적용한다.
 * 호출자가 executeAsModal 안에 있어야 한다 (모달 중첩 방지).
 */
async function run(doc, params) {
  await clearOwnLayers(doc);

  // **필름이 아니라 "색이 바뀌는가"로 판단한다.** 필름을 꺼도 그레이딩이 살아
  // 있으면 적용할 것이 있다. 이전에는 film.enabled만 보고 빠져나가서, 미리보기는
  // 그레이딩을 보여주는데 적용은 아무것도 하지 않았다.
  if (!film.hasEffect(params)) return;

  const size = (params.film && params.film.lutSize) || 33;
  const table = film.buildForParams(params, size);
  await apply.applyLut(doc, table, size, PREFIX);
}

/** 단일 문서용 진입점. 모달 래핑과 히스토리 병합을 담당한다. */
async function applyToActiveDocument(params) {
  return ps.modal("Film Simulation 적용", async (executionContext) => {
    const doc = ps.activeDocument();
    const history = await executionContext.hostControl.suspendHistory({
      documentID: doc.id,
      name: `Film Color: ${params.name || "Untitled"}`,
    });
    try {
      await run(doc, params);
    } finally {
      await executionContext.hostControl.resumeHistory(history);
    }
  });
}

module.exports = { run, applyToActiveDocument, PREFIX };
