/**
 * Photoshop batchPlay 래퍼와 저수준 액션 헬퍼.
 * 모든 문서 변경은 executeAsModal 안에서만 실행되어야 한다.
 */

const { app, core, action } = require("photoshop");

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

/** channel: "red" | "grain"(=green) | "blue" | "RGB"(composite) */
function selectChannel(channel) {
  return {
    _obj: "select",
    _target: [{ _ref: "channel", _enum: "channel", _value: channel }],
  };
}

/** 보이는 레이어를 병합해 새 레이어로 스탬프한다 (Ctrl+Alt+Shift+E). */
function stampVisible() {
  return { _obj: "mergeVisible", duplicate: true };
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
 * 채록 — Photoshop에서 문서를 하나 열고 알림 리스너로 `get` 디스크립터를 덤프해
 * 확인했다(2026-07-25). 반환 객체의 `profile` 필드가 프로파일 이름 문자열이다.
 * 프로파일이 없는 문서에서는 필드 자체가 없어 undefined가 나오므로 null로 정규화한다.
 *
 * 표시용 색 변환기를 고르는 데 쓴다 — UXP는 `<img>`를 sRGB로 간주해 그리므로
 * ProPhoto 문서를 그대로 넘기면 어둡게 보인다(UXP-NOTES 5.2).
 */
async function documentProfile() {
  try {
    const r = await play([
      { _obj: "get", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }] },
    ]);
    return (r[0] && r[0].profile) || null;
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
  selectChannel,
  stampVisible,
  percentToPixels,
  activeDocument,
};
