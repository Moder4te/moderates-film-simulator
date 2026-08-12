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
 * ── 유도 ────────────────────────────────────────────────────────────────
 *
 * 입사식 노출계로 기준을 잡은 −2/−1/0/+1/+2스톱 브래킷(ISO만 바꿔 정확히
 * 1스톱씩 뗀다 — HDR 카메라 응답함수 복원과 같은 문제라 상대 노출을 정확히
 * 아는 게 핵심이다) 5장을 "Adobe Standard" + 슬라이더 0으로 현상해
 * `tools/derive-acr-curve.py`로 뽑았다 — 픽셀 2,160개(720지점 × RGB)에서
 * Debevec–Malik류 최소자승으로 "ACR이 렌더링한 코드값 v → 실제 상대
 * 로그노광" 응답함수를 복원한다. 원본(`N1braket/`)은 raw·360MB TIFF라
 * 로컬 전용이고 저장소엔 없다 — 재현하려면:
 *
 *   python tools/derive-acr-curve.py \
 *     a.tif:-2 b.tif:-1 c.tif:0 d.tif:1 e.tif:2
 *
 * **검산 — 왕복.** 복원한 곡선으로 같은 브래킷의 스톱 간격을 다시 재면:
 *
 *   구간         보정 전(median)   보정 후(median)
 *   −2→−1스톱    1.58              0.97
 *   −1→ 0스톱    1.43              1.02
 *    0→+1스톱    1.06              1.01
 *   +1→+2스톱    0.61              0.94
 *
 * 보정 전엔 0.61~1.58로 요동치던 것이 보정 후 전 구간 0.94~1.02로 모인다 —
 * 곡선이 실제로 그 왜곡을 되돌린다는 뜻이다.
 *
 * ⚠️ **표본 범위는 인코딩값 0.0667~0.9647이다**(도구가 실제 표본이 있던
 * 구간을 그대로 보고한다). 그 밖(깊은 그림자·거의 포화)은
 * 실측이 없어 양끝 값으로 평평하게 고정한다(`curve.tabulate`) — 없는 데이터를
 * 추정해 이어 붙이는 것보다 안전하다.
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
  [0.0667, -1.71637],
  [0.1139, -1.39018],
  [0.1612, -1.09001],
  [0.2085, -0.75702],
  [0.2557, -0.53121],
  [0.303, -0.37122],
  [0.3503, -0.13622],
  [0.3975, 0.04004],
  [0.4448, 0.16576],
  [0.4921, 0.27475],
  [0.5393, 0.43225],
  [0.5866, 0.61205],
  [0.6338, 0.78349],
  [0.6811, 0.90123],
  [0.7284, 1.00162],
  [0.7756, 1.19013],
  [0.8229, 1.44852],
  [0.8702, 1.57735],
  [0.9174, 1.71878],
  [0.9647, 1.88288],
];
// 제어점은 `tools/derive-acr-curve.py`가 낸 것을 그대로 옮긴 것이다(재현 명령은
// 위 유도 문단 참조) — v_lo/v_hi가 어중간한 이유도 그 도구가 **실제 표본이 있던
// 범위**를 그대로 보고하기 때문이다.
const acrStandardG = curve.tabulate(curve.pchip(ACR_STANDARD_CTRL), 0.0667, 0.9647, 512);
function acrStandardDecode(v) {
  return ANCHOR * Math.exp(acrStandardG(v));
}
// `decode(v) = 0.18`을 만족하는 v — 이분법. 정박점 자체가 실측 앵커는 아니다(위 주석).
function acrStandardMidGray() {
  let lo = 0.0667, hi = 0.9647;
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
      "⚠️ Sony ILCE-7RM5 + ACR 18.3.2 한 세트에서 유도, 다른 카메라는 근사치.",
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

module.exports = {
  all,
  byId,
  applyable,
  HEADROOMS,
  DEFAULT_HEADROOM,
  ANCHOR,
  WORKING_GAMMA,
};
