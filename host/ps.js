/**
 * Photoshop batchPlay 래퍼와 저수준 액션 헬퍼.
 * 모든 문서 변경은 executeAsModal 안에서만 실행되어야 한다.
 */

const { app, core, action } = require("photoshop");

/**
 * batchPlay 래퍼.
 *
 * **모든 명령에 "대화상자를 띄우지 말 것"을 붙인다.** 이 플러그인의 어떤 동작도
 * Photoshop 대화상자를 띄워서는 안 된다 — 자동화 중에 떠 버리면 사용자는 왜
 * 나왔는지 알 수 없고, 미리보기처럼 자주 도는 경로에서는 작업이 막힌다.
 *
 * 실제로 그런 일이 있었다. 문서 프로파일을 읽는 `get` 하나가 인쇄 설정까지
 * 평가해 **미리보기를 열 때마다 프린터 대화상자가 떴다.** 근본 원인은 따로
 * 고쳤지만(documentProfile 참조), 같은 일이 다른 디스크립터에서 또 일어나지
 * 않도록 여기서 한 번에 막는다.
 *
 * 호출자가 `_options`를 직접 준 경우는 존중한다.
 */
async function play(commands) {
  const list = (Array.isArray(commands) ? commands : [commands]).map((cmd) =>
    cmd && cmd._options
      ? cmd
      : Object.assign({}, cmd, { _options: { dialogOptions: "dontDisplay" } })
  );
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
 * 채록 — Photoshop에서 문서를 하나 열고 알림 리스너로 `get` 디스크립터를 덤프해
 * 확인했다(2026-07-25). 반환 객체의 `profile` 필드가 프로파일 이름 문자열이다.
 * 프로파일이 없는 문서에서는 필드 자체가 없어 undefined가 나오므로 null로 정규화한다.
 *
 * 표시용 색 변환기를 고르는 데 쓴다 — UXP는 `<img>`를 sRGB로 간주해 그리므로
 * ProPhoto 문서를 그대로 넘기면 어둡게 보인다(UXP-NOTES 5.2).
 */
async function documentProfile() {
  try {
    // **속성 하나만 요청한다.** `_target`에 객체 참조만 주면 문서 디스크립터를
    // 통째로 가져오는데, 그 과정에서 Photoshop이 **인쇄 설정까지 평가해 프린터
    // 대화상자가 뜬다.** 미리보기를 열 때마다 프린터 창이 나오던 원인이었다.
    //
    // `_property`를 앞에 두는 형태가 "이 객체의 이 속성만"을 뜻한다.
    const r = await play([
      {
        _obj: "get",
        _target: [
          { _property: "profile" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
      },
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
