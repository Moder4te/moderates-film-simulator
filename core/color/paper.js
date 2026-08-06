/**
 * 인화지 스테이지 — 네거티브를 포지티브로 바꾸는 **진짜 단계**.
 *
 * ── 이 파일이 생긴 이유 ─────────────────────────────────────────────────
 *
 * `film.js` 4단계는 원래 이랬다.
 *
 *     P = 0.18 · 10^(pg · (D − D₀))        pg = film.printGamma
 *
 * 그리고 `films.js`의 `printGamma`는 **필름마다 `1/γ_G`** 였다. 즉 4단계를 지나면
 * 어느 필름이든 녹감층 실효대비가 **정확히 1.000**이 된다. 필름이 실제로 갖고 있는
 * 대비 차이(Agfa Ultra 50 γ_G 0.767 ↔ Portra 800 0.531, **44% 차이**)가 여기서
 * 통째로 지워졌다.
 *
 * `scanner.js` 헤더가 적어 둔 증상 세 개 중 하나가 그것이다 —
 * "**필름 간 차이가 작다 — 평균 R 폭 6.2 / G 폭 4.7**". 스캐너 스테이지는 그 증상을
 * 가리는 반창고였지, 원인을 고친 게 아니었다.
 *
 * 실제로는 **모든 필름이 같은 인화지에 인화된다.** 인화지 감마는 필름과 무관한
 * 상수이고, 그래서 대비가 센 필름은 센 인화물이 된다. 그게 필름 룩의 절반이다.
 *
 * ── 물리 ────────────────────────────────────────────────────────────────
 *
 *   인화 노광   log Hp = k − D_neg     네거티브가 확대기 빛을 막는다
 *   인화지 응답 Dp = paper(log Hp)
 *   반사율      P = 10^(−Dp)           이게 곧 인화물의 밝기다
 *
 * `k`는 채널별 인화 노광량 = **확대기 색 필터**다. 기준 그레이가 중성으로
 * 인화되도록 잡는다 — 실제 인화에서 필터를 돌려 오렌지 마스크를 상쇄하는 그 작업이고,
 * 예전 `D₀` 정규화가 하던 일과 같다.
 *
 * **부호를 확인할 것.** 밝은 피사체 → 네거 농도 높음 → 인화 노광 적음 → 인화지
 * **발끝** → 인화지 농도 낮음 → 밝은 인화물. 즉 인화지의 **발끝이 하이라이트**를,
 * **어깨가 암부**를 만든다. `film.js`의 `whitePoint:"rolloff"` 편법이 흉내 내던
 * 것이 바로 인화지 발끝이다.
 *
 * ── 직선 인화지는 예전 모델과 대수적으로 같다 ───────────────────────────
 *
 * paper(x) = Dmin + γp·(x − x₀) 를 넣으면
 *
 *     P = 10^(−paper(k − D)) = 0.18 · 10^(γp · (D − D₀))
 *
 * 예전 수식 그대로다. 그래서 이 파일은 **동작을 바꾸지 않고** 들어올 수 있었고,
 * `normalized` 프로파일이 비트 단위로 예전과 같다.
 */

const { pchip, monotonic } = require("./curve");

const ANCHOR = 0.18; // 18% 그레이
// 기준 그레이가 인화물에서 가져야 할 반사농도. −log10(0.18).
// 곡선형 인화지의 인화 노광 k를 이 값에서 역산한다.
const D_REF = -Math.log10(ANCHOR);

const PAPERS = [
  {
    id: "normalized",
    displayName: "정규화 (구 동작)",
    note:
      "인화지를 모델링하지 않는다. 필름마다 녹감 실효대비가 1.0이 되도록 " +
      "printGamma를 1/γ_G로 잡는다 — v2.18까지의 동작이다. " +
      "⚠️ 필름 간 대비 차이가 사라진다.",
    perFilmGamma: true,
  },
  {
    id: "shared",
    displayName: "공유 감마",
    note:
      "인화지 감마를 필름과 무관한 상수로 둔다. 필름 간 대비 차이가 살아난다. " +
      "⚠️ 감마 크기는 실측 인화지 곡선이 아니라 우리 필름 9종의 평균에서 왔다.",
    // 0.5859 = films.js 컬러 네거티브 9종의 γ_G(H −1~+1) 평균. 그 역수를 쓰면
    // **평균적인 필름의 룩은 지금과 같게 유지되고**, 필름 간 편차만 되살아난다.
    // 실측: 기준 그레이 필름 간 폭 3.4 → 13.0, 75% 지점 16.2 → 76.3 (8bit 단위).
    //
    // ⚠️ 실제 RA-4 인화지는 γ ≈ 2.5~3.0이다. 그 값을 넣으면 전체 대비가 지금의
    // 1.5배가 되어 룩이 통째로 바뀐다 — 그건 실측 곡선이 들어온 뒤에 R1과 묶어
    // 판단할 일이지, 여기서 추정으로 밀어 넣을 값이 아니다.
    gamma: 1.7066,
  },
];

const BY_ID = new Map(PAPERS.map((p) => [p.id, p]));

function all() {
  return PAPERS;
}

function byId(id) {
  return BY_ID.get(id) || BY_ID.get("normalized");
}

/**
 * 인화지 곡선을 **역으로** 읽는다 — 농도 Dp를 내는 인화 노광 log Hp.
 *
 * 인화 노광 k를 정하는 데만 쓴다(기준 그레이가 D_REF로 인화되도록). 인화지 곡선은
 * 단조 증가라 이분법으로 안전하게 뒤집힌다. 격자점마다가 아니라 **채널당 한 번**
 * 부르므로 속도는 문제가 되지 않는다.
 */
function invert(fn, target, lo, hi) {
  if (fn(lo) > target || fn(hi) < target) {
    throw new Error(
      `인화지 곡선이 기준 농도 ${target.toFixed(3)}에 닿지 않습니다 ` +
        `(범위 ${fn(lo).toFixed(3)}~${fn(hi).toFixed(3)}). 곡선 데이터를 확인하십시오.`
    );
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 한 채널의 인화 변환을 만든다. 네거티브 농도 D → 선형 포지티브 P.
 *
 * @param {object} paper   프로파일 (`byId`가 준 것)
 * @param {object} film    필름 정의 (`perFilmGamma` 프로파일이 printGamma를 쓴다)
 * @param {string} channel "r" | "g" | "b"
 * @param {number} d0      이 채널의 기준 그레이 농도. 인화 노광 k를 여기 맞춘다
 * @returns {(D:number) => number}
 */
function transferFor(paper, film, channel, d0) {
  // 직선 인화지 — 예전 수식 그대로. `normalized`는 필름별, `shared`는 공유.
  if (!paper.curves) {
    const g = paper.perFilmGamma ? film.printGamma : paper.gamma;
    if (!(g > 0)) {
      throw new Error(`인화지 ${paper.id}: 감마가 없습니다 (필름 ${film.id})`);
    }
    return function print(D) {
      return ANCHOR * Math.pow(10, g * (D - d0));
    };
  }

  // 곡선 인화지 — 실측 D-logE. 기준 그레이가 D_REF로 인화되도록 k를 역산한다.
  const pts = paper.curves[channel];
  if (!pts) throw new Error(`인화지 ${paper.id}: ${channel} 곡선이 없습니다`);
  const fn = pchip(monotonic(pts));
  const k = invert(fn, D_REF, pts[0][0], pts[pts.length - 1][0]) + d0;
  return function print(D) {
    return Math.pow(10, -fn(k - D));
  };
}

/**
 * 이 인화지에서 그 필름·채널의 **실효대비**(기울기 곱). 진단·문서용이다.
 * 직선이면 정확히 γ_neg × γp, 곡선이면 기준 그레이 부근의 국소 기울기다.
 */
function effectiveGamma(paper, film, channel, curveFn, d0) {
  const t = transferFor(paper, film, channel, d0);
  const h = 0.5;
  const a = Math.log10(t(curveFn(-h)));
  const b = Math.log10(t(curveFn(+h)));
  return (b - a) / (2 * h);
}

module.exports = { all, byId, transferFor, effectiveGamma, ANCHOR, D_REF };
