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

function curve(hs, ds) {
  if (hs.length !== ds.length) throw new Error("인화지 곡선 샘플 길이 불일치");
  return hs.map((h, i) => [h, ds[i]]);
}

// KODAK PROFESSIONAL ENDURA Premier Paper (E-4070, 2017-12) 4쪽 Characteristic Curves.
// x는 **절대** 로그노광(lux-seconds)이다 — 필름 곡선의 상대 H와 달리 0점이 정해져 있다.
// 그래서 인화 노광 k가 이 축 위의 실제 위치를 뜻한다. 균등 31점으로 재샘플했고
// 원본 305점 대비 재구성 최대오차 0.0138 D다(21점이면 0.0162, 41점도 0.0138 —
// 남은 오차는 샘플 수가 아니라 pchip과 원본 베지에의 차이다).
const H_ENDURA = [
  -3.0001, -2.9051, -2.8101, -2.7150, -2.6200, -2.5250, -2.4300, -2.3349,
  -2.2399, -2.1449, -2.0499, -1.9548, -1.8598, -1.7648, -1.6698, -1.5747,
  -1.4797, -1.3847, -1.2896, -1.1946, -1.0996, -1.0046, -0.9095, -0.8145,
  -0.7195, -0.6245, -0.5294, -0.4344, -0.3394, -0.2444, -0.1493,
];

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
    // ⚠️ **실측과는 거리가 있다.** 아래 Endura Premier의 직선부 γ는 3.93~4.10이다.
    // 이 프로파일은 "실측 인화지를 대신하는 값"이 아니라 **필름 간 편차만 되살리고
    // 평균 룩은 건드리지 않는 중간 단계**로 남겨 둔 것이다. 실측 곡선을 쓸 수 있으면
    // 그쪽을 쓰는 게 맞다.
    gamma: 1.7066,
  },
  {
    id: "kodak-endura-premier",
    displayName: "Kodak Endura Premier",
    note:
      "RA-4 실측 곡선. 직선부 γ R 3.98 / G 3.93 / B 4.10, Dmin 0.10 / 0.10 / 0.08, " +
      "Dmax 2.76 / 2.53 / 2.44. 발끝이 하이라이트를, 어깨가 암부를 만든다. " +
      "인화 스케일로 실측 감마를 shared와 같은 시스템감마로 눌러 정상 노출폭에서 " +
      "암부·명부가 뭉개지지 않게 했다(곡선 형태·채널별 감마 차이는 그대로). " +
      "필름 간 대비 차이는 살아 있다.",
    source: {
      document: "Kodak Alaris E-4070 (December 2017), p4 Characteristic Curves",
      retrieved: "2026-08-06",
      method: "PDF 벡터 경로 좌표 추출 (tools/extract_tds_curves.py, paper 모드)",
      note:
        "0.5초 노광, RA-4 95°F 45초, **Status A** 농도. 곡선 3개가 각각 별도 " +
        "벡터 경로라 x-backtrack 분리가 필요 없었다. 원본 범위 logE -3.00 ~ -0.149 " +
        "(왼쪽 프레임에서 잘림 — 그 끝값이 진짜 Dmin이다, 발끝이 이미 평평하다). " +
        "⚠️ 인화지는 오렌지 마스크가 없어 층 순서 불변식(B>G>R)이 성립하지 않는다 — " +
        "여기서는 오히려 R>G>B다(Dmax 기준).",
    },
    curves: {
      r: curve(H_ENDURA, [
        0.104, 0.104, 0.104, 0.104, 0.104, 0.104, 0.104, 0.104,
        0.104, 0.105, 0.107, 0.111, 0.122, 0.151, 0.207, 0.317,
        0.491, 0.746, 1.091, 1.501, 1.944, 2.289, 2.509, 2.636,
        2.700, 2.721, 2.742, 2.752, 2.752, 2.752, 2.752,
      ]),
      g: curve(H_ENDURA, [
        0.104, 0.104, 0.104, 0.104, 0.104, 0.104, 0.104, 0.104,
        0.104, 0.106, 0.107, 0.112, 0.123, 0.156, 0.219, 0.341,
        0.534, 0.816, 1.179, 1.581, 1.944, 2.202, 2.345, 2.433,
        2.478, 2.494, 2.510, 2.522, 2.523, 2.523, 2.523,
      ]),
      b: curve(H_ENDURA, [
        0.079, 0.079, 0.079, 0.079, 0.079, 0.079, 0.079, 0.079,
        0.079, 0.080, 0.082, 0.087, 0.097, 0.128, 0.185, 0.304,
        0.497, 0.786, 1.161, 1.578, 1.953, 2.204, 2.324, 2.390,
        2.419, 2.425, 2.434, 2.441, 2.442, 2.442, 2.442,
      ]),
    },
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
 * 실측 곡선 인화지의 **인화 스케일**.
 *
 * kBase 하나만 맞추면(기준 그레이 앵커) 곡선의 실제 형태·감마가 그대로 남는다.
 * 문제는 실측 감마가 가파르다는 것(Endura Premier 그린 ~3.93) — 필름의 정상
 * 노출폭(±2스톱)에 그대로 걸면 인화지의 좁은 직선부(로그노광폭 ~0.86)를 1스톱
 * 안에 다 써버려 암부·명부가 뭉개진다. 실측: Portra 400 그린 채널로 H=-2.0과
 * H=-1.5(1.5스톱 구간)를 인화하면 반사율이 소수점 4자리까지 완전히 같다 —
 * 그 구간의 정보가 통째로 사라졌다는 뜻이다.
 *
 * 실제 인화에서는 이걸 인화지 등급(콘트라스트 그레이드)·확대기 필터·부분
 * 노광으로 네거의 농도폭을 인화지 유효 노광폭에 맞춰 넣는다. 등급 선택 대신
 * 로그노광 축을 스케일해 같은 일을 한다 — 곡선의 실제 모양(발끝·어깨의
 * 비대칭, 채널별 감마 차이)은 그대로 두고, 그 축의 "빽빽한 정도"만 편다.
 *
 * 목표 시스템감마는 `shared` 프로파일의 감마(필름 9종 평균 감마의 역수,
 * 이미 검증된 값)를 그대로 쓴다. 그러면 평균적인 필름은 shared와 비슷한
 * 국소 대비로 인화되면서, 실측 곡선의 비선형 형태(진짜 필름다운 하이라이트
 * 롤오프)와 채널별 감마 차이(R 3.98 / G 3.93 / B 4.10 — 살짝 다른 색조)는
 * 그대로 살아 있다. 필름마다 다른 감마는 손대지 않으므로 필름 간 대비
 * 차이(이 파일이 생긴 이유)도 그대로 유지된다.
 */
const DESIGN_SYSTEM_GAMMA = 1.7066; // "shared" 프로파일과 같은 값 — 위 설명 참조

function localSlope(fn, x) {
  const h = 0.02; // kBase 부근 국소 기울기. 채널당 두 번만 부른다
  return (fn(x + h) - fn(x - h)) / (2 * h);
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

  // 곡선 인화지 — 실측 D-logE. 기준 그레이가 D_REF로 인화되도록 kBase를 역산한다.
  const pts = paper.curves[channel];
  if (!pts) throw new Error(`인화지 ${paper.id}: ${channel} 곡선이 없습니다`);
  const fn = pchip(monotonic(pts));
  const kBase = invert(fn, D_REF, pts[0][0], pts[pts.length - 1][0]);

  // 인화 스케일 — 실측 국소감마를 목표감마로 눌러 농도 축을 다시 잰다.
  const measuredGamma = localSlope(fn, kBase);
  if (!(measuredGamma > 0)) {
    throw new Error(`인화지 ${paper.id}: ${channel} 채널의 기준점 감마를 구할 수 없습니다`);
  }
  const scale = DESIGN_SYSTEM_GAMMA / measuredGamma;

  return function print(D) {
    return Math.pow(10, -fn(kBase - scale * (D - d0)));
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
