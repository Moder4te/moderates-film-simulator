/**
 * 마감 파이프라인 — 광학·매체 효과만 한다.
 *
 * 순서는 결과에 직접 영향을 준다.
 *
 *   → 할레이션   하이라이트에서 번진다. 그레인보다 먼저여야 노이즈가 번지지 않는다
 *   → 그레인     매체 특성이므로 최상단
 *
 * **색은 건드리지 않는다.** 색이 필요하면 엔진 플러그인을 먼저 적용하거나,
 * 이미 현상된 파일(Lightroom 프로파일을 거친 JPEG 등)을 입력으로 쓴다.
 *
 * ── 레이어 이름 ────────────────────────────────────────────────────────
 *
 * `FilmSim Finish`로 시작하는 것만 만들고, 재적용 시 그것만 지운다.
 * 엔진 플러그인은 `FilmSim Color`를 쓴다. **접두사를 공유하면 한쪽을 적용할 때
 * 다른 쪽 결과가 지워진다** — 두 플러그인을 같은 문서에 겹쳐 쓰는 것이 정상
 * 사용이므로 이 구분이 필수다.
 */

const ps = require("../lib/host/ps");
const halation = require("./halation");
const grain = require("./grain");

const PREFIX = "FilmSim Finish";

/** 이 플러그인이 이전에 만든 레이어/그룹을 제거한다. 엔진 것은 건드리지 않는다. */
async function clearOwnLayers(doc) {
  for (let guard = 0; guard < 12; guard++) {
    const targets = doc.layers.filter((l) => l.name.startsWith(PREFIX));
    if (targets.length === 0) break;
    for (const layer of targets) {
      await layer.delete();
    }
  }
}

/** 방금 만든 레이어들을 하나의 그룹으로 묶는다. 그룹째 켜고 끄거나 강도 조절 가능. */
async function groupOwnLayers(doc) {
  const targets = doc.layers.filter((l) => l.name.startsWith(PREFIX));
  if (targets.length < 1) return;
  const ref = targets.map((l) => ({ _ref: "layer", _id: l.id }));
  await ps.play([{ _obj: "select", _target: ref, makeVisible: false }]);
  await ps.play([
    {
      _obj: "make",
      _target: [{ _ref: "layerSection" }],
      from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
    },
    ps.renameLayer(PREFIX),
  ]);
}

async function run(doc, params) {
  const medium = params.medium || { format: "35mm", reference: "document" };
  await clearOwnLayers(doc);
  await halation.apply(doc, params.halation, medium.format, PREFIX);
  await grain.apply(doc, params.grain, medium, PREFIX);
  await groupOwnLayers(doc);
}

/** 단일 문서용 진입점. 모달 래핑과 히스토리 병합을 담당한다. */
async function applyToActiveDocument(params) {
  return ps.modal("Film Finish 적용", async (executionContext) => {
    const doc = ps.activeDocument();
    const history = await executionContext.hostControl.suspendHistory({
      documentID: doc.id,
      name: `Film Finish: ${params.name || "Untitled"}`,
    });
    try {
      await run(doc, params);
    } finally {
      await executionContext.hostControl.resumeHistory(history);
    }
  });
}

module.exports = { run, applyToActiveDocument, PREFIX };
