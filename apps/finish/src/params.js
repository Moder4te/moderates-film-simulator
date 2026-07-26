/**
 * 마감 파라미터. 프리셋 JSON의 스키마이자 UI 상태의 단일 소스.
 *
 * **색을 다루지 않는다.** 필름·스캐너·그레이딩은 엔진 플러그인(apps/engine)의
 * 소관이고 이 스키마에 없다. 여기서 다루는 것은 매체의 물리적 특성뿐이다 —
 * 입자와 산란.
 */

function defaultParams() {
  return {
    version: "2.0",
    kind: "finish",
    name: "Untitled",
    category: "",
    tags: [],

    /**
     * 매체(필름면) 기준. 그레인과 할레이션이 함께 쓴다 — 둘 다 필름면에서
     * 크기가 고정이고, 최종 이미지에서 달라 보이는 것은 확대율 차이다.
     */
    medium: {
      // "35mm" | "645" | "66" | "67" | "4x5"
      format: "35mm",
      // 그레인 크기 계산의 긴 변 기준. "document" | "standard" | "high" | "custom"
      reference: "document",
      // reference가 "custom"일 때 쓸 긴 변 px. 웹 축소본 크기 등을 직접 지정한다.
      customLongEdge: 2048,
    },

    halation: {
      enabled: true,
      // 할레이션이 발생하는 최소 휘도 0~255
      threshold: 205,
      // 합성 불투명도 0~100
      strength: 45,
      // 확산 반경. 이미지 긴 변 대비 비율(%). 포맷 배율이 곱해진다.
      radius: 1.2,
      // 채널별 반경 배율. 레드가 가장 넓게 퍼지는 것이 할레이션의 핵심 특징.
      channelSpread: { r: 1.0, g: 0.55, b: 0.3 },
      // 틴트 (HSL colorize)
      tintHue: 18,
      tintSaturation: 65,
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
      // 입자 크기 0~100 → 필름면 유효 입자 지름 2~42µm.
      // 기본값 20이 10µm으로, Portra 400의 유효 입자 크기다.
      size: 20,
      // "mono" | "rgb"
      colorMode: "mono",
    },
  };
}

/**
 * 저장된 프리셋을 현재 스키마로 승격.
 *
 * v1.x 통합 프리셋에는 film·grading이 섞여 있다. 그대로 실어 두면 같은 파일을
 * 엔진 플러그인에서 열 때 그쪽이 자기 부분을 읽는다.
 *
 * v1.5 이전 프리셋에는 medium이 없다. 기본값(35mm / 문서 기준)으로 채우면
 * 할레이션은 배율 1.0이라 그대로 재현되고, 그레인만 물리 모델로 다시 계산된다.
 */
function migrate(raw) {
  const base = defaultParams();
  if (!raw || typeof raw !== "object") return base;

  const h = raw.halation || {};
  return {
    ...base,
    ...raw,
    kind: "finish",
    medium: { ...base.medium, ...(raw.medium || {}) },
    halation: {
      ...base.halation,
      ...h,
      channelSpread: { ...base.halation.channelSpread, ...(h.channelSpread || {}) },
    },
    grain: { ...base.grain, ...(raw.grain || {}) },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { defaultParams, migrate, clamp };
