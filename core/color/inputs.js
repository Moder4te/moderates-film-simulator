/**
 * 입력 전달함수 — **문서의 코드값이 무슨 광량을 뜻하는가.**
 *
 * `film.js` 1단계(`L = decode(v)`)를 갈아 끼우는 자리다. 기본은 ProPhoto γ1.8이고
 * 그것이 이 프로젝트의 베이스 정의다(→ `docs/ARCHITECTURE.md` 「중립 현상이 정확히
 * 무엇인가」). 나머지는 그 정의를 만족시키지 못하거나, 만족시키되 **다른 자리에**
 * 기준 그레이를 두는 소스들이다.
 *
 * ── 왜 별도 파일인가 ────────────────────────────────────────────────────
 *
 * 처음엔 `film.js`에 상수 하나(`PROPHOTO_INPUT`)로 있었고, S-Log3은 `cube.js`가
 * 따로 들고 있었다. 이제 소비자가 둘이다 — 엔진(적용·미리보기)과 내보내기. 두 곳이
 * 각자 정의를 들면 **같은 이름의 전달함수가 서로 다른 수를 낼 수 있다.** 한 곳에 둔다.
 *
 * ── 규약 ────────────────────────────────────────────────────────────────
 *
 *   decode(v)  코드값 → 선형. **기준 그레이가 선형 0.18에 오도록** 맞춘다
 *   hWhite     코드 1.0이 만드는 로그노광 = log10(decode(1) / 0.18)
 *
 * ⚠️ `hWhite`를 빼먹으면 조용히 틀린다. 화이트포인트 정규화와 리버설 기준점이 이 값을
 * 쓰는데, 상수로 박힌 값을 그대로 쓰면 소스에 따라 몇 스톱씩 어긋난다. 그래서 둘을
 * **한 객체로 묶어** 따로 못 넘기게 했다.
 *
 * ⚠️ 원색은 여기서 다루지 않는다. 톤 축만이다. S-Gamut3.Cine처럼 원색이 다른 소스는
 * 호출자가 선형 공간에서 3×3을 따로 걸어야 한다(`core/io/cube.js`의 `convertPrimaries`).
 */

const colorspace = require("./colorspace");

const ANCHOR = 0.18;
const WORKING_GAMMA = 1.8;
const LOG2 = Math.log10(2);

/**
 * 리니어 현상본의 **헤드룸** — 기준 그레이 위로 몇 스톱을 담는가.
 *
 * raw를 톤 커브 없이 현상하면 조건 (b)가 구성상 만족된다. 대신 문제가 하나 생긴다:
 * **0~1 통에 씬을 어디에 놓을 것인가.** 기준 그레이를 0.18에 두면 위로 2.47스톱뿐이라
 * 하늘·창·스페큘러가 통째로 잘린다. 지우려는 그 베이스라인 톤 커브가 사고 있던 것이
 * 정확히 그 범위다.
 *
 * 그래서 기준 그레이를 내려 담는다. 얼마나? **모델이 실제로 응답하는 만큼**이다.
 * 실측(전 필름 × Endura, 기준 위 스톱당 출력 증가, 8bit):
 *
 *   +1     +2     +3     +4     +5     +6
 *   36.5   32.7   25.3   15.1    9.0    3.5   Portra 400  (C-41)
 *   35.8   32.4   25.5   15.1    8.9    3.6   Vision3 500T (ECN-2)
 *   56.3   39.1   17.5    7.6    2.1    0.9   Agfa Ultra 50 (C-41, 최고대비)
 *
 * **+5가 경계다.** 그 위로는 스톱당 3코드값 미만이라 통이 잘라도 필름 롤오프와
 * 구분되지 않는다. 그 아래로 자르면 아직 살아 있는 계조(+4→+5에서 7.6~15.1)를
 * **디지털로** 자르게 되고 그건 필름 롤오프가 아니다.
 *
 * ⚠️ 실측된 어깨는 Agfa 두 종(4.0 / 4.5스톱)뿐이다. 나머지 7종은 TDS가 직선부에서
 * 잘려 어깨 데이터가 없다. +5는 그 두 어깨를 확실히 품는 값이기도 하다.
 *
 * ⚠️ **ECN-2가 더 관용적이지 않다** — 적어도 우리 데이터에서는. Vision3와 Portra 400의
 * 스톱별 응답이 소수점까지 사실상 같다. 관용도를 가르는 것은 공정이 아니라 **대비**다.
 */
const HEADROOMS = [4, 5, 6];
const DEFAULT_HEADROOM = 5;

/**
 * 리니어 현상본 전달함수. 파일은 ProPhoto 원색 · γ1.8 인코딩이되, 기준 그레이가
 * `1/2^stops` 선형에 놓여 있다.
 *
 *   decode(v) = v^1.8 · 0.18 · 2^stops
 *
 * 확인: stops=5면 기준 그레이의 파일값은 선형 1/32 = 인코딩 0.1459이고,
 * decode(0.1459) = 0.03125 × 5.76 = 0.18 → H = 0. 코드 1.0은 +5스톱.
 */
function linearInput(stops) {
  const gain = ANCHOR * Math.pow(2, stops);
  return {
    id: `linear-h${stops}`,
    displayName: `리니어 +${stops}스톱`,
    note:
      `톤 커브 없이 현상한 ProPhoto 16bit. 기준 그레이가 인코딩 ` +
      `${Math.pow(Math.pow(2, -stops), 1 / WORKING_GAMMA).toFixed(4)}(8bit ` +
      `${Math.round(Math.pow(Math.pow(2, -stops), 1 / WORKING_GAMMA) * 255)})에 있고 ` +
      `코드 1.0이 +${stops}스톱이다. ⚠️ 눈으로 보면 어둡다 — 보는 파일이 아니라 먹이는 파일.`,
    decode: (v) => Math.pow(v, WORKING_GAMMA) * gain,
    hWhite: stops * LOG2,
    // 이 헤드룸으로 현상하려면 raw 쪽에서 기준 그레이를 여기 놔야 한다.
    midGrayEncoded: Math.pow(Math.pow(2, -stops), 1 / WORKING_GAMMA),
  };
}

/**
 * ACR "Adobe Standard" 렌더링의 숨은 톤 커브를 **역산해 되돌린다.**
 *
 * `docs/RESOLVED.md`(2026-08-12) "ACR Adobe Standard도 조건 (b)를 만족하지
 * 않는다"에서 이 커브의 존재를 실측으로 확인했다 — Camera Raw로 "Adobe
 * Standard" 프로필 + 슬라이더 전부 0으로 현상해도 암부는 게인이 더 걸리고
 * 하이라이트는 덜 걸리는 매끈한 S자 대비가 남는다. 그 결과 지금까지는 raw를
 * Camera Raw로 그냥 현상해 먹이면 필름 곡선이 엉뚱한 입력 위에서 돌았다.
 *
 * ── 유도 (2026-10-07, N6) ────────────────────────────────────────────────
 *
 * 24색 차트를 입사식 노출계 기준 −4~+4스톱 9장(ISO만 바꿈)으로 찍고
 * (`N1braket/9stopwithcolor/`, 로컬 전용), 같은 raw를 두 길로 풀었다 — ACR
 * "Adobe Standard" + 슬라이더 0 현상(코드 v)과 libraw 선형(`decode-raw.py`의
 * `load_linear`). **무채색 6패치 × 9스톱 × 3채널**의 (v, 선형) 쌍에 ln v 축 3차
 * 다항식 + 어깨 항 −ln(1.05−v)을 최소자승으로 맞췄다. 잔차 RMS 0.100스톱. 표본
 * 범위 v=0.016~0.984.
 * 재현:
 *
 *   python tools/measure-chart.py N1braket/9stopwithcolor/tiff N1braket/9stopwithcolor --fit-curve
 *
 * **왜 예전 유도(벽 브래킷 + Debevec, `tools/derive-acr-curve.py`)를 버렸나.**
 * 그 커브는 국소 기울기 dg/dv가 0.85~6.75로 **출렁였다**(극값 19개). 무채색은
 * 세 채널이 같은 값이라 출렁임이 안 드러나 왕복 검산·정합성 검사를 다 통과했다.
 * 그런데 채도는 g(v_최대) − g(v_최소)라서, 기울기가 출렁이면 **밝기에 따라 채도가
 * 출렁인다** — 실사진(sample/MDR03671) 피부가 회색·분홍 얼룩으로 갈라졌다(N6
 * 보고의 실제 원인). 저차 다항식은 기울기가 매끄럽다는 것을 구성으로 보장한다
 * (극값 1개 — 암부 가파름 → 중간 완만 → 어깨에서 다시 가파름, S자 역함수 꼴).
 * 얼굴의 채도비 흩어짐(리니어 대비) 0.336 → 0.086.
 *
 * ⚠️ **이 곡선은 Sony ILCE-7RM5 + ACR 18.3.2(Process Version 15.4) +
 * "Adobe Standard" 프로필 한 세트에서 유도됐다.** 다른 카메라는 근사치다(N3).
 * 조건 (a) 앵커도 실측이 아니다 — `midGrayEncoded`는 `decode(v)=0.18`을 만족하는
 * v를 그대로 계산한 것이다. 같은 사진의 linear-h5와 1.3스톱 어긋났다(노출
 * 슬라이더로 상쇄된다).
 */
const ACR_FIT = {
  lo: 0.016, // 실제 표본이 있던 최저 v — 그 아래는 ln v 축 직선 외삽
  shoulder: 0.05,
  coef: [-2.468745, 0.446547, -0.191557, -0.005655, 0.877738], // ln v의 0~3차, 마지막은 −ln(1+ε−v)
};
// 위 명령의 출력을 그대로 옮긴 것이다. 제어점으로 바꿔 pchip으로 잇지 **않는다** —
// 그러면 기울기에 작은 출렁임(극값 5개)이 다시 생긴다. 식을 그대로 계산한다.

/** 피팅식 ln(선형) — 앵커 전. */
function acrFitLn(v) {
  const c = ACR_FIT.coef, x = Math.log(v);
  return c[0] + x * (c[1] + x * (c[2] + x * c[3])) - c[4] * Math.log(1 + ACR_FIT.shoulder - v);
}
// d(ln 선형)/d(ln v) at lo — 아래 외삽의 기울기(= 유효감마)
const ACR_LO_SLOPE = (() => {
  const c = ACR_FIT.coef, x = Math.log(ACR_FIT.lo), v = ACR_FIT.lo;
  return c[1] + 2 * c[2] * x + 3 * c[3] * x * x + c[4] * v / (1 + ACR_FIT.shoulder - v);
})();

/**
 * 표본 아래(v < 0.016)는 **ln v 축 직선**으로 잇는다(N4, 2026-08-14).
 *
 * 평평하게 고정하면 "거기는 전부 같은 밝기"라는 틀린 추정이 되고, v축 직선이면
 * `g(0)`이 유한해져 검정이 뜬다. 인코딩은 거듭제곱꼴이라 `v→0`에서 `g→−∞`여야 하고,
 * 그건 ln v 축 직선일 때 성립한다. ⚠️ 여전히 외삽이다(8bit 0~4) — 카메라
 * 다이내믹레인지의 물리적 하한이라 브래킷을 넓혀도 완전히는 못 없앤다.
 * 위쪽(v 0.984~1)은 어깨 항이 있는 매끈한 식 자체가 잇는다.
 */
function acrRawLn(v) {
  if (v >= ACR_FIT.lo) return acrFitLn(v);
  return acrFitLn(ACR_FIT.lo) + ACR_LO_SLOPE * (Math.log(v) - Math.log(ACR_FIT.lo));
}
// 조건 (a) 관례 — 인코딩 0.3857(ProPhoto 18% 그레이 자리)을 0.18로. 실측 앵커가 아니다
const ACR_ANCHOR_LN = acrRawLn(0.3857);

function acrStandardDecode(v) {
  if (v <= 0) return 0;
  return ANCHOR * Math.exp(acrRawLn(v) - ACR_ANCHOR_LN);
}
// `decode(v) = 0.18`을 만족하는 v — 이분법. 정박점 자체가 실측 앵커는 아니다(위 주석).
function acrStandardMidGray() {
  let lo = ACR_FIT.lo, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (acrStandardDecode(mid) < ANCHOR) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * **색상 보존 톤 커브의 역** — ACR은 톤 커브를 채널마다 따로 걸지 않는다.
 *
 * DNG SDK `RefBaselineRGBTone`: 선형 ProPhoto에서 **최대·최소 채널에만** 커브를 걸고,
 * 중간 채널은 둘 사이를 원래 비율 그대로 보간한다(색상 보존). 그러니 역도 같은 꼴이어야
 * 한다 — 채널별로 `decode`하면 중간 채널이 엉뚱한 자리로 가서 **색상각이 돈다**
 * (N6 실측, 2026-10-06: 잎 +17° · 초록 −17° · 황록 +12°. 색상 보존 역으로 ±2° 안쪽.
 * `tools/measure-chart.py`).
 *
 * ⚠️ **프로필 테이블(HueSatMap·LookTable)은 되돌리지 않는다.** HueSatMap은 ForwardMatrix와
 * 짝을 이루는 색 보정이고, LookTable은 효과가 작다(ACR에서 LookTable만 항등으로 바꾼
 * 프로필로 현상해 대조: 유채색 ΔE 중앙 2.2) — 되돌리려던 시도는 오히려 나빠져 걷어냈다
 * (2026-10-07, `docs/RESOLVED.md`).
 *
 * 엔진은 채널별 `decode`를 축마다 미리 계산하는 구조라(`core/color/film.js`) 여기서는
 * 선형값이 아니라 **등가 코드**를 돌려준다: 채널별 `decode`에 넣으면 색상 보존 역과
 * 같은 선형값이 나오는 v. 최대·최소 채널은 원래 v 그대로이고 중간 채널만 바뀐다.
 *
 * @returns {(r:number, g:number, b:number, out:Float64Array) => boolean}
 *          등가 코드 3개를 out에 쓴다. 무채색이라 바뀔 게 없으면 false(out은 그대로 입력)
 */
function remapCodes(inp) {
  const N = 4096;
  const tab = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) tab[i] = inp.decode(i / N);
  const inv = (L) => {
    if (L >= tab[N]) return 1;
    let lo = 0, hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tab[mid] <= L) lo = mid; else hi = mid;
    }
    const span = tab[hi] - tab[lo];
    return (lo + (span > 0 ? (L - tab[lo]) / span : 0)) / N;
  };
  return function remap(r, g, b, out) {
    out[0] = r; out[1] = g; out[2] = b;
    let mx = 0, mn = 0;
    for (let c = 1; c < 3; c++) {
      if (out[c] > out[mx]) mx = c;
      if (out[c] < out[mn]) mn = c;
    }
    if (out[mx] === out[mn]) return false;
    // 색상 보존 역 — 보간은 ACR 작업 공간(선형) 값에서, 인코딩을 푼 y = v^γ
    const md = 3 - mx - mn;
    const y = (c) => Math.pow(out[c], WORKING_GAMMA);
    const t = (y(md) - y(mn)) / (y(mx) - y(mn));
    const lmn = inp.decode(out[mn]);
    out[md] = inv(lmn + t * (inp.decode(out[mx]) - lmn));
    return true;
  };
}

const INPUTS = [
  {
    id: "prophoto",
    displayName: "ProPhoto γ1.8 (기본)",
    note: "「중립 현상」의 정의 그대로. 기준 그레이가 인코딩 0.3857(8bit 98)에 있다.",
    // `colorspace.prophotoDecode`가 아니라 순수 거듭제곱인 것은 **의도적이다** —
    // v2.18까지의 동작과 비트 단위로 같아야 한다. ROMM의 발끝 직선부(v<0.031248)는
    // 여기 들어온 적이 없다.
    decode: (v) => Math.pow(v, WORKING_GAMMA),
    hWhite: Math.log10(1 / ANCHOR),
    midGrayEncoded: Math.pow(ANCHOR, 1 / WORKING_GAMMA),
  },
  ...HEADROOMS.map(linearInput),
  {
    id: "acr-standard",
    displayName: "ACR Adobe Standard (역산, 실험적)",
    note:
      "Camera Raw로 \"Adobe Standard\" 프로필 + 슬라이더 전부 0으로 그냥 현상한 파일용. " +
      "숨은 톤 커브를 역산해 되돌린다 — decode-raw.py 없이 raw를 곧장 현상해도 된다. " +
      "⚠️ Sony ILCE-7RM5 + ACR 18.3.2 한 세트에서 유도, 다른 카메라는 근사치. " +
      "표본 범위(0.016~1.0) 밖(=v<0.016, 8bit 0~4)만 외삽이다 — ln v 축. " +
      "톤 커브는 ACR과 같은 색상 보존 방식으로 되돌린다(24색 차트에서 ACR 무(無)룩 렌더 대비 " +
      "유채색 ΔE 중앙 2.2). 프로필의 색 보정(HueSatMap)은 그대로 둔다 — 되돌릴 룩이 아니다.",
    decode: acrStandardDecode,
    remap: true, // → remapCodes. 엔진이 유채색 격자점마다 중간 채널 코드를 옮긴다
    hWhite: Math.log10(acrStandardDecode(1) / ANCHOR),
    midGrayEncoded: acrStandardMidGray(),
  },
  {
    id: "slog3",
    displayName: "Sony S-Log3",
    note:
      "로그 촬영본. 기준 그레이 = 코드 0.41056, 코드 1.0 = 선형 38.4(+7.74스톱). " +
      "⚠️ 원색이 S-Gamut3.Cine이라 톤만으로는 부족하다 — 3×3을 따로 걸어야 한다.",
    decode: colorspace.slog3Decode,
    encode: colorspace.slog3Encode,
    hWhite: Math.log10(colorspace.slog3Decode(1) / ANCHOR),
    midGrayEncoded: colorspace.slog3Encode(ANCHOR),
    toProPhoto: colorspace.SGAMUT3CINE_TO_PROPHOTO,
  },
];

const BY_ID = new Map(INPUTS.map((i) => [i.id, i]));

function all() {
  return INPUTS;
}

function byId(id) {
  return BY_ID.get(id) || BY_ID.get("prophoto");
}

/** 엔진 패널에 노출할 것 — 원색 변환이 필요한 것은 내보내기 전용이라 뺀다. */
function applyable() {
  return INPUTS.filter((i) => !i.toProPhoto);
}

/**
 * 입력 × 인화지 조합 점검 — **어깨 없는 인화지에 로그폭을 넣지 않았는가.**
 *
 * `normalized`·`shared`는 직선 인화지라 어깨가 없다. 하이라이트를 눌러 주는 것은
 * `film.js`의 합성 롤오프(무릎 0.5의 지수 소프트클립)뿐인데, 그것이 담을 수 있는
 * 범위는 기준 그레이 위 **약 2.5스톱**이다. 리니어 입력은 +4~+6스톱을 담고
 * 들어오므로 남는 것이 지수 꼬리에서 수치적으로 포화한다 — 채널마다 포화 시점이
 * 달라 **일부 채널만 1.0에 붙고 색상이 틀어진다**(실측: linear-h6 × normalized,
 * 33³의 55%가 부분 클리핑).
 *
 * ⚠️ **코드로 못 고친다.** 무릎을 아무리 낮춰도 지수 소프트클립으로 6스톱을 [0,1]에
 * 분해능 있게 넣을 수 없고(필요 무릎 < −1.1), 로그 톤맵으로 바꾸는 것은 곧
 * **어깨를 합성으로 만드는 것** — 그건 인화지가 할 일이다. 그래서 막지 않고
 * **알린다**: 리니어 입력에는 실측 곡선 인화지를 쓰라고.
 *
 * @returns {string|null} 경고 문구, 문제 없으면 null
 */
function combinationWarning(inputId, paperHasCurves) {
  const inp = byId(inputId);
  const stops = inp.hWhite / Math.log10(2);
  if (paperHasCurves || stops <= 3) return null;
  return (
    `입력 소스 「${inp.displayName}」는 기준 그레이 위 ${stops.toFixed(1)}스톱을 담는데, ` +
    "선택한 인화지는 어깨가 없어 약 2.5스톱까지만 눌러 줍니다. 하이라이트에서 " +
    "채널마다 다른 지점이 잘려 **색이 틀어집니다.** 인화지를 실측 곡선 " +
    "(Kodak Endura Premier)으로 바꾸거나, 입력을 ProPhoto γ1.8로 바꾸세요."
  );
}

module.exports = {
  all,
  byId,
  applyable,
  combinationWarning,
  remapCodes,
  HEADROOMS,
  DEFAULT_HEADROOM,
  ANCHOR,
  WORKING_GAMMA,
};
