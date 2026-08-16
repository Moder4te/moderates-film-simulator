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
const curve = require("./curve");

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
 * ── 유도 (2026-08-16 재촬영, N4) ─────────────────────────────────────────
 *
 * 입사식 노출계로 기준(0스톱)을 잡고 조리개·셔터를 고정한 채 **ISO만 바꿔**
 * 10스톱(−4~+4.36)을 "Adobe Standard" + 슬라이더 0으로 현상해
 * `tools/derive-acr-curve.py`로 뽑았다. 예전(2026-08-12)엔 −2~+2 5장뿐이라
 * 표본이 v=0.0667~0.9647만 덮었다 — 그 밖은 평평 고정(→ln v축 외삽으로
 * 응급 처치, RESOLVED.md 참조)이었는데 이번이 근본 해결이다.
 *
 * 처음엔 8장(−4~+2.36)만 찍었는데 +3·+4스톱이 카메라 ISO 상한(12800)에
 * 막혀 두 프레임이 같은 노출로 나왔다(조리개·셔터 고정 + ISO도 같으면
 * 센서에 닿은 빛의 양이 같다) — 그래서 ISO를 확장 범위(25600·51200)까지
 * 올려 두 장을 더 찍었다. 최종 10장의 실측 스톱(EXIF ISO에서 역산,
 * ISO2500=0스톱 기준 `log2(iso/2500)`):
 * −3.9658 · −2.9658 · −1.9658 · −1 · 0 · +1 · +2 · +2.3561 · +3.3561 · +4.3561.
 * 원본(`N1braket/9stopbraket/`)은 raw·360MB TIFF라 로컬 전용, 저장소엔 없다.
 * 재현:
 *
 *   python tools/derive-acr-curve.py \
 *     a.tif:-3.9658 b.tif:-2.9658 c.tif:-1.9658 d.tif:-1 e.tif:0 \
 *     f.tif:1 g.tif:2 h.tif:2.3561 i.tif:3.3561 j.tif:4.3561
 *
 * ⚠️ **프레임을 짝수로 넘기면 도구가 표본 위치를 뽑는 기준 프레임이 바뀐다**
 * (`derive-acr-curve.py`의 `ref_stop`은 0스톱을 명시적으로 찾는다 — 2026-08-16
 * 이전엔 `stops[len(stops)//2]`라 프레임 개수에 따라 조용히 딴 프레임을 골랐다.
 * 8장으로 처음 돌렸을 때 암부 유효감마가 0.610→0.680으로만 움직였는데, 그
 * 버그를 안 고치고 10장으로 늘렸더니 0.340까지 튀어서 발견했다).
 *
 * **검산 — 왕복.** 복원한 곡선으로 같은 브래킷의 스톱 간격을 다시 재면:
 *
 *   구간              보정 전(median)   보정 후(median)
 *   −3.966→−2.966     1.41              0.90
 *   −2.966→−1.966     1.83              1.05
 *   −1.966→−1.000     1.53              0.95
 *   −1.000→ 0.000     1.39              1.01
 *    0.000→+1.000     0.99              1.03
 *   +1.000→+2.000     0.59              1.05
 *   +2.000→+2.356     0.11              0.27
 *   +2.356→+3.356     0.11              0.88
 *   +3.356→+4.356     0.06              0.92
 *
 * −1~+2, +2.356~+4.356 구간은 0.88~1.05로 잘 모인다. +2→+2.356만 0.27로 낮은데,
 * 그 좁은 구간(0.356스톱)에 ACR 하이라이트 롤오프의 시작점이 걸려 있어 로그-로그
 * 비례가 깨지는 게 정상이다 — 어깨 자체가 압축이다.
 *
 * ⚠️ **표본 범위는 인코딩값 0.0196~1.0000이다**(도구가 실제 표본이 있던 구간을
 * 그대로 보고한다). **명부 쪽은 이번에 v=1(코드 최대값)까지 실측으로 닿았다** —
 * 8장짜리 시도(+2.356스톱까지)와 달리 더 이상 위쪽 외삽이 없다. 아래쪽만
 * v<0.0196(8bit 기준 0~5)이 여전히 외삽이다(아래 `ACR_LO_SLOPE` 참조) — 카메라
 * 다이내믹레인지의 물리적 하한이라 브래킷을 더 넓혀도 완전히는 못 없앤다.
 *
 * ⚠️ **이 곡선은 Sony ILCE-7RM5 + ACR 18.3.2(Process Version 15.4) +
 * "Adobe Standard" 프로필 한 세트에서 유도됐다.** DCP 프로필은 카메라
 * 모델마다 조금씩 다르게 캘리브레이션되므로, 다른 카메라에서는 근사치다 —
 * Process Version의 공유 톤 응답이 큰 비중일 가능성이 높지만 검증되지
 * 않았다. 카드 없이 잰 조건 (a) 앵커도 마찬가지로 미확정이다(→ 아래
 * `midGrayEncoded`는 실측이 아니라 `decode(v)=0.18`을 만족하는 v를 그대로
 * 계산한 것 — 정박점 자체가 옳다는 보장은 없다. 노출 슬라이더로 상쇄된다).
 */
const ACR_STANDARD_CTRL = [
  [0.0196, -2.76411],
  [0.0712, -1.88521],
  [0.1228, -1.24895],
  [0.1744, -1.07966],
  [0.226, -0.61452],
  [0.2776, -0.4685],
  [0.3292, -0.35432],
  [0.3808, -0.03594],
  [0.4324, 0.19309],
  [0.484, 0.23688],
  [0.5356, 0.34259],
  [0.5872, 0.59712],
  [0.6388, 0.86635],
  [0.6904, 0.95298],
  [0.742, 1.009],
  [0.7936, 1.20493],
  [0.8452, 1.55328],
  [0.8968, 1.72263],
  [0.9484, 2.05702],
  [1.0, 3.27813],
];
// 제어점은 `tools/derive-acr-curve.py`가 낸 것을 그대로 옮긴 것이다(재현 명령은
// 위 유도 문단 참조) — v_lo가 어중간한 이유는 그 도구가 **실제 표본이 있던
// 범위**를 그대로 보고하기 때문이다. v_hi는 이제 정확히 1이다(위 참조).
//
// ⚠️ **맨 끝 두 점의 기울기가 급하다** — [0.9484,2.057]→[1.0,3.278]는 secant
// ≈23.7(그 앞 구간들의 secant는 4~7대). 처음엔 클리핑 픽셀이 섞여 든 잡음으로
// 의심해 잘라내려 했으나, `--ctrl-points 50`으로 더 촘촘히 뽑아 보니 v=0.90→1.00
// 구간이 1.73→1.81→1.94→2.27→2.67→3.28로 **매끈하게 가속**한다(튀는 점 없음) —
// 잡음이 아니라 ACR 하이라이트 롤오프(어깨)를 되돌리는 데 필요한 실제 이득이다.
// 어깨가 넓은 실노광 범위를 좁은 코드값에 욱여넣으므로, 그걸 펴는 역함수는
// v→1에서 가팔라지는 게 맞다.
const ACR_LO = ACR_STANDARD_CTRL[0][0];
const ACR_LO_G = ACR_STANDARD_CTRL[0][1];

/**
 * 표본 아래(v < 0.0196) 외삽 기울기. 유효감마 0.681이다
 * (순수 ProPhoto는 1.8 — ACR이 암부를 그만큼 들어올린다는 뜻).
 *
 * ── 왜 여기만 로그축인가 (N4, 2026-08-14 도입, 2026-08-16 표본 확장) ─────
 *
 * 처음엔 `tabulate`를 표본 범위로만 떠서, 그 밖이 **양끝 값으로 평평하게
 * 고정**됐다. 없는 데이터를 추정해 잇지 않는다는 원칙이었는데, 평평은
 * 추정을 안 하는 게 아니라 **"거기는 전부 같은 밝기다"라는 틀린 추정**이었다.
 *
 * 위쪽은 이제 외삽이 아니다 — 2026-08-16 재유도로 표본이 v=1까지 닿았다(위 참조).
 *
 * **아래쪽은 선형 외삽이면 안 된다.** v축에서 직선으로 이으면 `g(0)`이 유한해져
 * 검정이 밝게 뜬다. 인코딩은 원래 거듭제곱꼴이라 `v→0`에서 `g→−∞`여야 하고,
 * 그건 **ln v 축에서** 직선일 때 성립한다.
 *
 * ⚠️ **여전히 외삽이다** — v<0.0196 구간(8bit 기준 0~5)은 실측 밖이다. 카메라
 * 다이내믹레인지의 물리적 하한이라 브래킷을 더 넓혀도 완전히는 못 없앤다.
 */
const ACR_LO_SLOPE =
  (ACR_STANDARD_CTRL[1][1] - ACR_LO_G) /
  (Math.log(ACR_STANDARD_CTRL[1][0]) - Math.log(ACR_LO));

// 표본 하단부터 v=1까지 — 양끝 다 이제 실측 범위 안이다(위 주석 참조).
const acrStandardG = curve.tabulate(curve.pchip(ACR_STANDARD_CTRL), ACR_LO, 1, 512);

function acrStandardDecode(v) {
  if (v <= 0) return 0;
  if (v >= ACR_LO) return ANCHOR * Math.exp(acrStandardG(v));
  return ANCHOR * Math.exp(ACR_LO_G + ACR_LO_SLOPE * (Math.log(v) - Math.log(ACR_LO)));
}
// `decode(v) = 0.18`을 만족하는 v — 이분법. 정박점 자체가 실측 앵커는 아니다(위 주석).
function acrStandardMidGray() {
  let lo = ACR_LO, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (acrStandardDecode(mid) < ANCHOR) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
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
      "표본 범위(0.0196~1.0) 밖(=v<0.0196, 8bit 0~5)만 외삽이다 — ln v 축. " +
      "⚠️⚠️ 무채색 벽 브래킷에서 유도한 **톤 커브만 되돌린다** — 카메라 프로필의 " +
      "색상별 색 변환(HueSatMap)은 그대로 남아 있다. 채도 있는 피사체(피부·원색)에서 " +
      "색이 틀어지고 계조가 깨질 수 있다(TODO N6). 그런 사진에는 decode-raw.py를 쓸 것.",
    decode: acrStandardDecode,
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
  HEADROOMS,
  DEFAULT_HEADROOM,
  ANCHOR,
  WORKING_GAMMA,
};
