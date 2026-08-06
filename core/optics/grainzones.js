/**
 * 그레인 존(shadow/midtone/highlight) 톤 범위 — 교차점 2개에서 유도한다.
 *
 * 예전엔 존마다 독립된 [lo, hi] 범위를 하드코딩해 Blend If 4값을 계산했다
 * (`blendRangeFor`, apps/finish/src/grain.js에 있었다). 세 범위를 독립으로 잡고
 * 각각 ±feather를 더하니 커버리지 합이 182%가 됐고, 톤에 따라 가중치 합이
 * 0.00~1.31로 흔들려 존 슬라이더를 바꿔도 결과가 거의 안 변하는 증상으로
 * 이어졌다(G4, docs/PLAN-GRAIN-2026-08-02.md).
 *
 * 교차점 c1(암부↔중간톤 경계) · c2(중간톤↔명부 경계) 두 개만 잡으면 세 존의
 * 커버리지가 자동으로 정확히 이어 붙는다 — 어느 톤에서든 세 존의 가중치 합이
 * 항상 정확히 1이다(겹침·구멍이 원천적으로 불가능). Photoshop이 아니라 순수
 * 함수라 노드에서 값으로 검증할 수 있다(`tools/check-grain.js`).
 */

/**
 * 교차점 c1·c2(0~255)와 페더 폭으로 세 존의 Blend If 4값[blackMin,blackMax,
 * whiteMin,whiteMax]을 만든다.
 *
 * ⚠️ **half는 (c2-c1)/2로 clamp한다.** 페더 슬라이더 상한이 120인데(UI)
 * 기본 교차점 간격은 85 — clamp 없이 feather를 120까지 올리면 중간톤의 두
 * 램프(암부쪽·명부쪽)가 서로 지나쳐 역전되고 가중치 합이 깨진다(실측 —
 * clamp 없이 c1=120,c2=130,feather=60을 넣으면 이탈이 정확히 1.0으로
 * 터진다, tools/check-grain.js). 예전 `blendRangeFor`도 같은 이유로
 * `Math.min(feather, (hi-lo)/2)`로 clamp했었다 — 여기서도 그대로 지킨다.
 *
 * ⚠️ **교차점도 clamp·정렬해 전 함수(total)로 만든다.** 두 입력이 그냥 통과하면
 * 합이 1이라는 이 함수의 유일한 계약이 깨진다 — 실측으로 두 경우를 잡았다.
 *
 *   `c2 = 255`   `blendWeight`가 "최상단 존인가"를 `whiteMax >= 255`로 **값에서
 *                추론**한다. c2가 255면 midtone의 whiteMax도 255가 되어 midtone과
 *                highlight가 **둘 다** 최상단을 주장하고 각각 1을 낸다.
 *   `c2 < c1`    중간톤이 빈 구간이 되면서 암부와 명부가 같은 톤을 동시에 덮는다.
 *                슬라이더 두 개를 노출하면 사용자가 가장 먼저 하는 조작이다.
 *
 * 그래서 254 상한(255를 midtone에 넘기지 않는다)과 정렬을 여기서 건다.
 * **순서가 중요하다 — clamp를 먼저, 정렬을 나중에.** 반대로 하면 c1=c2=255에서
 * 정렬 뒤 clamp가 hi < lo를 만들어 같은 자리가 다시 터진다(실측).
 *
 * 근본 원인은 `blendWeight`가 위치가 아니라 값으로 바깥 경계를 판정하는 것이다.
 * 명시적 플래그로 바꾸는 편이 깨끗하지만 호출 규약이 바뀌므로, 지금은 입력을
 * 좁혀 계약을 지킨다. `tools/check-grain.js`가 전 입력을 훑어 이 성질을 지킨다.
 *
 * @param {number} c1 암부↔중간톤 교차점 (0~254로 clamp)
 * @param {number} c2 중간톤↔명부 교차점 (0~254로 clamp. c1과 순서가 바뀌면 정렬)
 * @param {number} feather 교차 구간 폭(px, 0~255 스케일)
 * @returns {{shadow:number[], midtone:number[], highlight:number[]}}
 */
function zoneRanges(rawC1, rawC2, feather) {
  const a = Math.min(254, Math.max(0, rawC1));
  const b = Math.min(254, Math.max(0, rawC2));
  const c1 = Math.min(a, b);
  const c2 = Math.max(a, b);
  const half = Math.min(feather / 2, Math.max(0, (c2 - c1) / 2));
  return {
    shadow: [0, 0, c1 - half, c1 + half], // 아래엔 크로스페이드할 존이 없다
    midtone: [c1 - half, c1 + half, c2 - half, c2 + half],
    highlight: [c2 - half, c2 + half, 255, 255], // 위에도 없다
  };
}

/**
 * Blend If 4값[blackMin,blackMax,whiteMin,whiteMax]이 루미넌스 L에서 만드는
 * 가중치(0~1) — Photoshop Underlying Layer 슬라이더와 같은, 흑측·백측 두 램프의
 * min이다(둘 중 하나라도 가리면 가려진다). 폭 0인 램프(blackMin==blackMax 등)는
 * 그 쪽에 크로스페이드가 없다는 뜻 — 즉시 1(또는 0)로 끊긴다.
 * `zoneRanges`가 만든 세 범위는 이 가중치의 합이 모든 L에서 정확히 1이 되도록
 * 설계됐다 — `tools/check-grain.js`가 이 성질을 값으로 확인한다.
 */
function blendWeight([blackMin, blackMax, whiteMin, whiteMax], L) {
  // 폭 0 램프 두 종류를 구분해야 한다. **바깥쪽**(암부의 blackMin=0, 명부의
  // whiteMax=255 — zoneRanges가 항상 이 두 값으로 박는다)은 그 너머로 넘길
  // 존이 없으니 경계를 포함해서 1이어야 한다. **안쪽**(교차점 c1·c2에서
  // feather=0일 때, UI 슬라이더 하한이 0이라 실제로 일어난다)은 인접 존과
  // 정확히 그 점에서 만나므로 **한쪽만 그 점을 가져야** 한다 — 안 가르면
  // 둘 다 1을 주장해 가중치 합이 2가 된다(실측으로 잡음, tools/check-grain.js).
  // black 쪽이 그 점을 갖고(암부→중간톤 관례), white 쪽은 255가 아닌 한 양보한다.
  const black = blackMax <= blackMin ? (L < blackMin ? 0 : 1) : clamp01((L - blackMin) / (blackMax - blackMin));
  const whiteIsOuterEdge = whiteMax >= 255;
  const white =
    whiteMax <= whiteMin
      ? whiteIsOuterEdge
        ? L > whiteMax ? 0 : 1
        : L >= whiteMax ? 0 : 1
      : clamp01((whiteMax - L) / (whiteMax - whiteMin));
  return Math.min(black, white);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

module.exports = { zoneRanges, blendWeight };
