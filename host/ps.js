/**
 * Photoshop batchPlay 래퍼와 저수준 액션 헬퍼.
 * 모든 문서 변경은 executeAsModal 안에서만 실행되어야 한다.
 */

const { app, core, action } = require("photoshop");

/**
 * batchPlay 래퍼.
 *
 * ⚠️ **모든 명령에 `_options`를 자동으로 붙이려다 미리보기를 죽였다.**
 * 대화상자를 막으려고 `_options: { dialogOptions: "dontDisplay" }`를 전 명령에
 * 넣었는데, `get`처럼 원래 그 필드를 받지 않는 디스크립터에서 batchPlay가
 * 끝나지 않았다. 그러면 호출자의 `busy` 플래그가 계속 참으로 남아 **이후 요청이
 * 전부 삼켜진다.**
 *
 * 대화상자를 막아야 한다면 **그 디스크립터에만** 붙인다. 여기서 일괄 처리하지
 * 않는다 — 어떤 디스크립터가 어떤 필드를 받는지는 문서화돼 있지 않고,
 * 추측으로 붙이면 조용히 멈춘다(UXP-NOTES 4).
 */
async function play(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  const result = await action.batchPlay(list, { synchronousExecution: false });
  return result;
}


/**
 * 모달 실행 래퍼. 중첩 호출을 피하기 위해 파이프라인 최상단에서 한 번만 감싼다.
 */
async function modal(commandName, fn) {
  return core.executeAsModal(fn, { commandName });
}

const TARGET_LAYER = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };

/** 현재 선택된 레이어의 이름을 바꾼다. */
function renameLayer(name) {
  return {
    _obj: "set",
    _target: [TARGET_LAYER],
    to: { _obj: "layer", name },
  };
}

/** 현재 선택된 레이어의 블렌드 모드와 불투명도를 설정한다. */
function setLayerBlend(mode, opacity) {
  const to = { _obj: "layer" };
  if (mode) to.mode = { _enum: "blendMode", _value: mode };
  if (typeof opacity === "number") {
    to.opacity = { _unit: "percentUnit", _value: opacity };
  }
  return { _obj: "set", _target: [TARGET_LAYER], to };
}

/**
 * Blend If (underlying layer) 설정.
 * 하단 레이어의 휘도 범위로 현재 레이어를 마스킹한다.
 * 존별 그레인의 핵심. 마스크 채널을 만들지 않아도 되고 비파괴적이다.
 *
 * blackMin < blackMax 구간에서 페이드 인, whiteMin < whiteMax 구간에서 페이드 아웃.
 */
function setUnderlyingBlendRange(blackMin, blackMax, whiteMin, whiteMax) {
  return {
    _obj: "set",
    _target: [TARGET_LAYER],
    to: {
      _obj: "layer",
      blendRange: [
        {
          _obj: "blendRange",
          channel: { _ref: "channel", _enum: "channel", _value: "gray" },
          srcBlackMin: 0,
          srcBlackMax: 0,
          srcWhiteMin: 255,
          srcWhiteMax: 255,
          destBlackMin: Math.round(blackMin),
          destBlackMax: Math.round(blackMax),
          destWhiteMin: Math.round(whiteMin),
          destWhiteMax: Math.round(whiteMax),
        },
      ],
    },
  };
}

/** 빈 픽셀 레이어 생성. 생성된 레이어가 자동으로 선택된다. */
function makePixelLayer() {
  return { _obj: "make", _target: [{ _ref: "layer" }] };
}

/** 현재 레이어를 특정 색으로 채운다. contents: "gray" | "black" | "white" */
function fillLayer(contents, mode = "normal", opacity = 100) {
  return {
    _obj: "fill",
    using: { _enum: "fillContents", _value: contents },
    mode: { _enum: "blendMode", _value: mode },
    opacity: { _unit: "percentUnit", _value: opacity },
  };
}

function addNoise(amount, monochromatic) {
  return {
    _obj: "addNoise",
    distort: { _enum: "distort", _value: "gaussianDistribution" },
    noise: { _unit: "percentUnit", _value: amount },
    monochromatic: !!monochromatic,
  };
}

function gaussianBlur(radiusPx) {
  return {
    _obj: "gaussianBlur",
    radius: { _unit: "pixelsUnit", _value: radiusPx },
  };
}

/**
 * Maximum(최대값) 필터 — 밝은 영역을 형태학적으로 팽창시켜 **원반(disk)**을 만든다.
 * 가우시안의 종형 곡선과 달리 특정 반경까지 꽉 찬 뒤 경계에서 뚝 떨어진다.
 * roundness로 사각이 아닌 원형 팽창. **반경은 1~100px 정수 상한**(PS 제약).
 */
function maximumFilter(radiusPx) {
  const r = Math.max(1, Math.min(100, Math.round(radiusPx)));
  return {
    _obj: "maximum",
    radius: { _unit: "pixelsUnit", _value: r },
    select: { _enum: "maximumMinimumSelectType", _value: "roundness" },
  };
}

/**
 * 활성 레이어를 percent%로 확대·축소한다 (중심 고정).
 *
 * 블룸 최적화용이다 — 넓게 번지는 성분은 **낮은 해상도에서 계산해도 결과가 같다.**
 * 1/4로 줄이면 픽셀은 1/16, 반경도 1/4이라 큰 반경 필터의 비용이 급감한다.
 *
 * 보간은 bilinear로 둔다. 어차피 곧 크게 blur할 것이라 더 비싼 보간이 의미가 없다.
 */
function scaleLayer(percent) {
  return {
    _obj: "transform",
    _target: [TARGET_LAYER],
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: {
      _obj: "offset",
      horizontal: { _unit: "pixelsUnit", _value: 0 },
      vertical: { _unit: "pixelsUnit", _value: 0 },
    },
    width: { _unit: "percentUnit", _value: percent },
    height: { _unit: "percentUnit", _value: percent },
    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bilinear" },
  };
}

/** channel: "red" | "grain"(=green) | "blue" | "RGB"(composite) */
function selectChannel(channel) {
  return {
    _obj: "select",
    _target: [{ _ref: "channel", _enum: "channel", _value: channel }],
  };
}

/**
 * 보이는 레이어를 병합해 **새 레이어로** 스탬프한다 (Ctrl+Alt+Shift+E).
 *
 * **디스크립터 두 개를 배열로 돌려준다.** 호출자는 펼쳐서 쓴다.
 *
 *     await play([...ps.stampVisible(), ps.renameLayer("...")]);
 *
 * ⚠️ `mergeVisible + duplicate` **하나만으로는 새 레이어가 생기지 않는다.**
 * 그 조작은 Photoshop에서도 "빈 레이어를 먼저 만들어 둔 상태"를 전제하고,
 * 그러지 않으면 병합 결과가 **활성 레이어 안으로 들어간다.** 활성 레이어가
 * 배경이면 배경이 스탬프로 바뀌고 원본이 사라진다.
 *
 * 실제로 그 일이 있었다. v1.x에서는 색 단계가 항상 픽셀 레이어를 먼저 만들어
 * 활성 상태로 남겼기 때문에 결함이 가려져 있었고, 마감 플러그인을 분리해 색
 * 단계가 빠지자 배경만 있는 JPEG에서 원본이 지워졌다.
 *
 * 그래서 "빈 레이어 생성"을 이 함수 안으로 넣었다. **호출자가 전제를 기억해야
 * 하는 API는 언젠가 또 틀린다.**
 */
function stampVisible() {
  return [makePixelLayer(), { _obj: "mergeVisible", duplicate: true }];
}

/** 이미지 긴 변 대비 비율(%)을 픽셀로 변환. 해상도 독립성 확보용. */
function percentToPixels(doc, percent) {
  const longEdge = Math.max(doc.width, doc.height);
  return Math.max(0.1, (longEdge * percent) / 100);
}

function activeDocument() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("열린 문서가 없습니다.");
  return doc;
}

/**
 * 활성 문서의 색 프로파일 이름. 읽지 못하면 null.
 *
 * 표시용 색 변환기를 고르는 데 쓴다 — UXP는 `<img>`를 sRGB로 간주해 그리므로
 * ProPhoto 문서를 그대로 넘기면 어둡게 보인다(UXP-NOTES 5.2).
 *
 * ── batchPlay를 쓰지 않는다 ─────────────────────────────────────────────
 *
 * 이 값 하나 때문에 두 번 사고가 났다.
 *
 *   1. `get`에 객체 참조만 줘서 문서 디스크립터를 통째로 읽었다. Photoshop이 인쇄
 *      설정까지 평가해 **미리보기를 열 때마다 프린터 대화상자가 떴다.**
 *   2. 고치려고 `_property`로 한정하고 `_options`를 붙였더니 **미리보기가 아예
 *      멈췄다.** batchPlay가 반환하지 않아 호출자의 잠금이 풀리지 않았다.
 *
 * batchPlay 디스크립터는 문서화가 부실해 추측이 통하지 않는다(UXP-NOTES 4).
 * **DOM 속성으로 읽으면 그 위험이 통째로 사라진다.** 문서 객체는 이미 `width`·
 * `resolution`·`bitsPerChannel` 같은 속성을 노출하고 있고, 프로파일 이름도 그중
 * 하나다. 호출도 동기라 멈출 여지가 없다.
 *
 * UXP 버전에 따라 속성 이름이 다를 수 있어 후보를 순서대로 본다. 전부 없으면
 * null을 돌려주고, 그러면 색 변환을 건너뛴다 — 미리보기가 조금 어긋날 뿐
 * 멈추지는 않는다.
 */
const PROFILE_KEYS = ["colorProfileName", "colorProfile", "profile"];

function documentProfile() {
  try {
    const doc = app.activeDocument;
    if (!doc) return null;
    for (const key of PROFILE_KEYS) {
      const v = doc[key];
      if (typeof v === "string" && v) return v;
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  play,
  modal,
  documentProfile,
  TARGET_LAYER,
  renameLayer,
  setLayerBlend,
  setUnderlyingBlendRange,
  makePixelLayer,
  fillLayer,
  addNoise,
  gaussianBlur,
  maximumFilter,
  scaleLayer,
  selectChannel,
  stampVisible,
  percentToPixels,
  activeDocument,
};
