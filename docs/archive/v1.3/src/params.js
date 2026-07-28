/**
 * 파라미터 모델. 프리셋 JSON의 스키마이자 UI 상태의 단일 소스.
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
    version: "1.0",
    name: "Untitled",
    category: "",
    tags: [],

    grading: {
      enabled: true,
      // "relative"는 기존 염료 농도에 비례해 가감, "absolute"는 절대량 가감.
      // 필름 룩은 relative가 더 자연스럽다.
      method: "relative",
      selectiveColor,
      // 채널별 게인. 1.0이 중립. 필름 특성곡선의 채널별 감도 차이 근사.
      channelGain: { r: 1.0, g: 1.0, b: 1.0 },
      // 특성곡선의 발끝/어깨. 0~100, 클수록 암부/명부가 눌린다.
      toe: 0,
      shoulder: 0,

      // 크로스토크 매트릭스 (필름 유제층 간 색 유출 근사).
      // Channel Mixer로 적용한다. matrix가 진실의 원천이며 프리셋에 그대로 저장된다.
      // 행 = 출력 채널(R,G,B), 열 = 소스 채널(R,G,B). 단위 %. 항등이 중립.
      // UI는 amount 슬라이더 하나만 노출해 대칭 매트릭스를 생성한다.
      // 비대칭 미세조정은 프리셋 JSON의 matrix를 직접 편집하면 된다.
      crosstalk: {
        enabled: false,
        amount: 0, // UI 대칭 강도(%). matrix를 파생 생성한다.
        matrix: [
          [100, 0, 0],
          [0, 100, 0],
          [0, 0, 100],
        ],
      },
    },

    grain: {
      enabled: true,
      // 존별 강도 0~100
      shadow: 25,
      midtone: 45,
      highlight: 15,
      // 존 경계 (0~255 루미넌스). 인접 존과 페더 구간에서 겹친다.
      shadowRange: [0, 85],
      midtoneRange: [60, 195],
      highlightRange: [170, 255],
      feather: 40,
      // 입자 크기 0~100. 내부적으로 노이즈 후 블러 반경으로 매핑된다.
      size: 20,
      // "mono" | "rgb"
      colorMode: "mono",
    },

    halation: {
      enabled: true,
      // 할레이션이 발생하는 최소 휘도 0~255
      threshold: 205,
      // 합성 불투명도 0~100
      strength: 45,
      // 확산 반경. 이미지 긴 변 대비 비율(%)로 저장해 해상도 독립성을 확보한다.
      radius: 1.2,
      // 채널별 반경 배율. 레드가 가장 넓게 퍼지는 것이 할레이션의 핵심 특징.
      channelSpread: { r: 1.0, g: 0.55, b: 0.3 },
      // 틴트 (HSL colorize)
      tintHue: 18,
      tintSaturation: 65,
    },
  };
}

/**
 * 저장된 프리셋을 현재 스키마로 승격. 누락 필드는 기본값으로 채운다.
 * 구버전 프리셋을 깨뜨리지 않기 위해 필수.
 */
function migrate(raw) {
  const base = defaultParams();
  if (!raw || typeof raw !== "object") return base;

  return {
    ...base,
    ...raw,
    grading: { ...base.grading, ...(raw.grading || {}),
      selectiveColor: { ...base.grading.selectiveColor, ...((raw.grading || {}).selectiveColor || {}) },
      channelGain: { ...base.grading.channelGain, ...((raw.grading || {}).channelGain || {}) },
      crosstalk: { ...base.grading.crosstalk, ...((raw.grading || {}).crosstalk || {}) } },
    grain: { ...base.grain, ...(raw.grain || {}) },
    halation: { ...base.halation, ...(raw.halation || {}),
      channelSpread: { ...base.halation.channelSpread, ...((raw.halation || {}).channelSpread || {}) } },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 대칭 크로스토크 강도(%)로 3x3 매트릭스를 생성한다.
 * 각 출력 채널이 이웃 두 채널로 amount%씩 유출되고, 대각선은 100 - 2*amount로
 * 보정해 전체 밝기를 유지한다. (등방 근사; 비대칭은 matrix 직접 편집)
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

/**
 * 매트릭스에서 대표 대칭 강도를 역산한다 (off-diagonal 6개 평균).
 * 프리셋 로드 시 UI 슬라이더 위치를 복원하는 용도. 비대칭 매트릭스면 근사값.
 */
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
