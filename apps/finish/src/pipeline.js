/**
 * 마감 파이프라인 — 광학·매체 효과만 한다.
 *
 * 순서는 결과에 직접 영향을 준다.
 *
 *   → 그레이딩   톤·색 미세 조정. **제일 앞**이다 — 색을 확정하고 광학을 얹는다.
 *                할레이션이 조정된 하이라이트에서 발생해야 자연스럽다.
 *   → 디퓨전     해상도를 입자에 묶는 베이스 처리. **할레이션보다 먼저** 돌려야
 *                한다 — stampVisible/getPixels가 합성본을 잡아, 할레이션이 이미
 *                있으면 디퓨전 레이어에 구워져 할레이션을 끌 수 없다(토글 불가 버그).
 *   → 할레이션   하이라이트에서 번진다. 디퓨전 위, 그레인 아래의 독립 screen
 *                레이어로 남아 나중에 켜고 끌 수 있다.
 *   → 그레인     매체 특성이므로 최상단. 노이즈가 할레이션에 번지지 않는다.
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
const grading = require("./grading");
const halation = require("./halation");
const grain = require("./grain");

const PREFIX = "FilmSim Finish";

/**
 * 이 플러그인이 이전에 만든 레이어/그룹을 제거한다. 엔진 것은 건드리지 않는다.
 *
 * **재귀로 훑는다.** 최상위만 보면 마감 그룹이 다른 그룹 안에 들어가 있을 때
 * (사용자가 정리하려고 묶는 것은 정상 사용이다) 못 찾아 재적용마다 그레인·할레이션이
 * 누적된다. 그리고 **마감은 엔진보다 이게 더 급하다** — 엔진 산출물은 픽셀 레이어
 * 한 장이라 지우고 다시 하면 되지만, 마감의 디퓨전은 그 시점 합성본을 이미 구워
 * 놓아서 되돌릴 지점이 없다. 게다가 마감은 `groupOwnLayers`로 **자기가 그룹을
 * 만든다** — 중첩 가능성을 스스로 만들어 놓고 중첩을 못 찾고 있었다.
 *
 * 그룹의 delete()는 그룹만 해제(ungroup)하고 안의 레이어를 꺼낸다. 그래서 대상이
 * 없어질 때까지 반복한다 — 첫 회에 그룹이 풀리고 다음 회에 개별 레이어가 지워진다.
 * 해제로 무효가 된 참조는 무시한다. 하나 던지는 것으로 재적용 전체가 멈추면 안 된다.
 */
async function clearOwnLayers(doc) {
  for (let guard = 0; guard < 16; guard++) {
    const targets = ps.collectLayers(doc.layers, (l) => l.name && l.name.startsWith(PREFIX), []);
    if (targets.length === 0) break;
    for (const layer of targets) {
      try {
        await layer.delete();
      } catch (e) {
        /* 그룹 해제로 이미 사라진 참조 — 다음 반복에서 다시 훑는다 */
      }
    }
  }
}

/**
 * 방금 만든 레이어들을 하나의 그룹으로 묶는다. 그룹째 켜고 끄거나 강도 조절 가능.
 *
 * ⚠️ **여기는 재귀로 만들지 말 것.** 목적이 "방금 만든 최상위 레이어들"을 묶는
 * 것이다. `clearOwnLayers`와 짝을 맞추려고 `ps.collectLayers`로 바꾸면, 사용자가
 * 다른 그룹 안에 넣어 둔 과거 마감 레이어까지 끌어내 묶어 버린다.
 */
async function groupOwnLayers(doc) {
  const targets = doc.layers.filter((l) => l.name && l.name.startsWith(PREFIX));
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
  // 그레이딩 → 디퓨전 → 할레이션 → 그레인. 디퓨전이 할레이션보다 먼저여야 할레이션이
  // 독립 레이어로 남아 토글 가능하다(grain.applyDiffusion 주석 참조).
  await grading.apply(doc, params.tone, PREFIX);
  await grain.applyDiffusion(doc, params.grain, medium, PREFIX);
  await halation.apply(doc, params.halation, medium.format, PREFIX);
  await grain.applyGrain(doc, params.grain, medium, PREFIX);
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
