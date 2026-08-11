/**
 * 필름 엔진 파라미터. 프리셋 JSON의 스키마이자 UI 상태의 단일 소스.
 *
 * **색만 다룬다.** 할레이션·그레인·포맷은 마감 플러그인(apps/finish)의 소관이고
 * 이 스키마에 없다.
 */

const SELECTIVE_COLOR_RANGES = [
  "reds",
  "yellows",
  "greens",
  "cyans",
  "blues",
  "magentas",
  "whites",
  "neutrals",
  "blacks",
  // 피부톤 — 고정 6색역과 달리 **색상각 + 채도 창**으로 판정하는 의사 색역이다.
  // reds·yellows와 대역이 겹치므로 **더하기**로 쌓인다(그 둘을 0으로 두고 피부만
  // 만지면 피부만 바뀐다). 판정과 근거는 core/color/gamut.js의 skinWeight.
  "skin",
];

function emptyCMYK() {
  return { c: 0, m: 0, y: 0, k: 0 };
}

function defaultParams() {
  const selectiveColor = {};
  for (const range of SELECTIVE_COLOR_RANGES) {
    selectiveColor[range] = emptyCMYK();
  }

  return {
    version: "2.0",
    kind: "engine",
    name: "Untitled",
    category: "",
    tags: [],

    film: {
      enabled: true,
      id: "kodak-portra-400",
      exposure: 0, // 스톱. 필름 정의의 exposureRange 안이어야 한다.
      // 입력 소스 — 문서의 코드값이 무슨 광량인가. core/color/inputs.js
      // "prophoto"(기본, 「중립 현상」의 정의) | "linear-h4|5|6"(톤 커브 없이 현상한 것)
      input: "prophoto",
      // 인화지. "normalized"(구 동작) | "shared" | "kodak-endura-premier"(실측).
      // ⚠️ 기본값이 구 동작이다 — 실측 인화지 톤을 쓰려면 골라야 한다(TODO S3b).
      paper: "normalized",
      scanner: "none", // 인화·스캔 장비 특성. 옵션이다 — 메인 톤은 인화지가 잡는다
      lutSize: 33, // 33 = 일반, 65 = 정밀
    },

    /**
     * 사용자 색 조정. 필름 룩 위에 얹힌다.
     *
     * v1.5까지는 이것을 **두 가지로 구현**했다 — 필름을 켜면 JS 근사를 LUT에 굽고,
     * 끄면 Photoshop 조정 레이어(grading.js)를 올렸다. 같은 슬라이더 값이 모드에
     * 따라 다른 결과를 냈다. v2.0에서 조정 레이어 경로를 버리고 **JS 하나로
     * 통일**했다. 화면·`.cube`·`.xmp`·적용이 전부 같은 수를 낸다.
     */
    grading: {
      enabled: true,
      // "relative"는 기존 염료 농도에 비례해 가감, "absolute"는 절대량 가감.
      method: "relative",
      selectiveColor,
      // 채널별 게인. 1.0이 중립.
      channelGain: { r: 1.0, g: 1.0, b: 1.0 },
      // 특성곡선의 발끝/어깨. 0~100, 클수록 암부/명부가 눌린다.
      toe: 0,
      shoulder: 0,

      // ── 피부톤 색역 설정 ────────────────────────────────────────────────
      // 대역 중심 색상각. 실측 피부(15~24°)의 양 끝을 균등하게 잡는 자리.
      // 스포이드로 찍으면 이 값이 바뀐다.
      skinHue: 19.5,
      // 대역 폭 0~100. 색상각과 채도 상한이 함께 움직인다 — 색상각만 넓히면
      // 채도 높은 목재가 먼저 들어온다. 넓히면 어두운 피부·황변색까지, 좁히면 중간톤만.
      // ⚠️ 넓힐수록 나무 바닥처럼 **실제로 피부색인 물체**가 딸려온다. 불가피하다.
      skinRange: 30,
      // 켜면 reds·yellows 조정이 피부를 비켜 간다. 붉은 옷만 만지고 피부는 지킬 때.
      protectSkin: false,

      // 크로스토크 매트릭스 (필름 유제층 간 색 유출 근사).
      // 행 = 출력 채널(R,G,B), 열 = 소스 채널. 단위 %. 항등이 중립.
      crosstalk: {
        enabled: false,
        amount: 0,
        matrix: [
          [100, 0, 0],
          [0, 100, 0],
          [0, 0, 100],
        ],
      },
    },
  };
}

/**
 * 저장된 프리셋을 현재 스키마로 승격.
 *
 * v1.x 통합 프리셋에는 grain·halation·medium이 섞여 있다. **버리지 않고 그대로
 * 실어 둔다** — 같은 파일을 마감 플러그인에서 열면 그쪽이 자기 부분을 읽는다.
 * 한 파일을 두 플러그인이 각자 필요한 만큼만 읽는 구조라 사용자가 프리셋을
 * 쪼갤 필요가 없다.
 */
function migrate(raw) {
  const base = defaultParams();
  if (!raw || typeof raw !== "object") return base;

  const g = raw.grading || {};
  return {
    ...base,
    ...raw,
    kind: "engine",
    film: { ...base.film, ...(raw.film || {}) },
    grading: {
      ...base.grading,
      ...g,
      selectiveColor: { ...base.grading.selectiveColor, ...(g.selectiveColor || {}) },
      channelGain: { ...base.grading.channelGain, ...(g.channelGain || {}) },
      crosstalk: { ...base.grading.crosstalk, ...(g.crosstalk || {}) },
    },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 대칭 크로스토크 강도(%)로 3x3 매트릭스를 생성한다.
 * 각 출력 채널이 이웃 두 채널로 amount%씩 유출되고, 대각선은 100 - 2*amount로
 * 보정해 전체 밝기를 유지한다.
 */
function crosstalkMatrixFromAmount(amount) {
  const a = clamp(amount, 0, 40);
  const d = 100 - 2 * a;
  return [
    [d, a, a],
    [a, d, a],
    [a, a, d],
  ];
}

/** 매트릭스에서 대표 대칭 강도를 역산한다 (off-diagonal 6개 평균). */
function crosstalkAmountFromMatrix(m) {
  if (!Array.isArray(m) || m.length !== 3) return 0;
  const off = m[0][1] + m[0][2] + m[1][0] + m[1][2] + m[2][0] + m[2][1];
  return Math.round((off / 6) * 10) / 10;
}

module.exports = {
  defaultParams,
  migrate,
  clamp,
  SELECTIVE_COLOR_RANGES,
  crosstalkMatrixFromAmount,
  crosstalkAmountFromMatrix,
};
