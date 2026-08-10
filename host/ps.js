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

/**
 * layers 트리를 재귀로 훑어 pred를 만족하는 레이어를 모은다(그룹 안까지).
 *
 * **왜 재귀여야 하나.** `doc.layers`는 최상위만 준다. 사용자가 플러그인 결과를
 * 그룹 안으로 끌어넣는 것은 정상 사용이고(정리하려고 묶는다), 그 뒤로는 최상위
 * 검색이 그것을 못 찾는다. 재적용할 때마다 이전 결과가 남아 색·그레인·할레이션이
 * **누적된다.**
 *
 * **왜 여기 있나.** 같은 함수가 엔진 세 곳에 복사돼 있었고 마감에는 아예 없었다.
 * 그래서 마감만 최상위 검색으로 남아 위 결함을 그대로 안고 있었다 — 이 저장소가
 * 가장 자주 낸 결함이 "구현이 둘이 되면 갈라진다"이다. 인자로 받은 트리를 훑을
 * 뿐 호스트를 부르지 않는 순수 함수지만, 두 앱이 이미 `host/ps`를 받아 가므로
 * 여기 두면 반입 목록(`tools/sync-libs.js`)을 건드리지 않고 한 벌로 합쳐진다.
 *
 * @param {Array} layers  훑을 트리 (보통 `doc.layers`)
 * @param {function} pred  (layer) => boolean
 * @param {Array} out  누산기. 호출자가 `[]`를 준다
 * @returns {Array} out
 */
function collectLayers(layers, pred, out) {
  for (const l of layers || []) {
    if (pred(l)) out.push(l);
    const kids = l.layers;
    if (kids && kids.length) collectLayers(kids, pred, out);
  }
  return out;
}

const TARGET_LAYER = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };

/** id로 레이어를 선택한다. `makeVisible: false` — 선택만 하고 가시성은 안 건드린다. */
function selectLayer(id) {
  return {
    _obj: "select",
    _target: [{ _ref: "layer", _id: id }],
    makeVisible: false,
  };
}

/**
 * 새 레이어가 **문서 최상위**에 생기도록 삽입 지점을 맞춘다.
 *
 * ⚠️ **왜 필요한가.** `makePixelLayer`(`make layer`)는 위치를 지정하지 않아 **활성
 * 레이어 옆에** 만든다. 그래서 산출물이 사용자가 무엇을 선택해 뒀는지에 따라 다른
 * 곳에 놓인다 — 실기에서 확인했다.
 *
 *   - 재적용 시 `clearOwnLayers`가 이전 그룹을 지우면 선택이 남은 그룹으로 떨어진다
 *   - 그러면 새 레이어가 **그 그룹 안**에 생긴다
 *   - `groupOwnLayers`는 문서 최상위만 보므로 못 찾고, **그룹이 아예 안 만들어진다**
 *
 * 자리만의 문제가 아니다. 산출물이 다른 그룹 안에 들어가면 그 그룹의 블렌드 모드·
 * 불투명도·마스크가 결과에 **다시** 곱해진다 — 읽을 때의 전제(최상단에 Normal로
 * 얹힌다)와 어긋난다. (구조상 그렇다는 것이고 실기로 재 보지는 않았다. 사고가 난
 * 문서의 그룹은 Normal 100%였다.)
 *
 * ⚠️ **그룹은 앵커로 쓸 수 없다.** 그룹을 선택한 상태로 `make layer`를 하면 새
 * 레이어가 그룹 **위가 아니라 안에** 생긴다. 패널에서 접힌 그룹을 고르고 새 레이어를
 * 누르는 것과 다르다 — 처음에 그 UI 동작을 그대로 가정했다가 틀렸다.
 * 실측(UXP-NOTES 2.3): `doc.layers` = `[그룹 2(자식 8), 배경]`에서 `그룹 2`를 선택하고
 * `make layer` → 자식 9, 만든 레이어의 `parent`가 `그룹 2`.
 *
 * 그래서 **그룹이 아닌 최상위 레이어**를 고른다. `doc.layers`는 위→아래 순서이므로
 * (같은 실측에서 확인) **앞에서부터** 찾는다 — 가장 위의 비그룹 레이어다.
 *
 * ── 위에서부터 찾는 이유 — 두 앱의 순서가 여기서 정해진다 ────────────────
 *
 * 아래에서부터 찾으면 앵커가 배경이 되어 산출물이 **맨 아래**에 깔린다. 실제로 그렇게
 * 만들었다가 마감이 엔진 색 레이어 밑으로 들어가 통째로 가려졌다 — 색 레이어는
 * 불투명 픽셀 레이어라 그 위를 덮는다.
 *
 * 위에서부터 찾으면 두 앱이 저절로 맞는다. **그룹은 건너뛰고 레이어만 앵커가 되는**
 * 성질 덕분이다.
 *
 *   - 마감이 만드는 것은 **그룹**(`FilmSim Finish`) → 엔진은 그것을 건너뛰고 그 아래
 *     사용자 레이어를 앵커로 잡는다. 색이 마감 **아래**로 들어간다
 *   - 엔진이 만드는 것은 **레이어**(`FilmSim Color`) → 마감은 그것을 앵커로 잡는다.
 *     마감이 색 **위**로 올라간다
 *
 * 결과가 항상 `배경 → 색 → 마감`이다. 적용 순서와 무관하게 쌓임 순서가 같아진다.
 *
 * ⚠️ **순서가 뒤집혔을 때 깨지는 것은 "가려짐"이지 "색"이 아니다.** 실기에서 확인했다 —
 * 마감이 색 아래에 깔렸을 때도 디퓨전은 색이 적용된 합성본을 구웠고 색 자체는
 * 멀쩡했다. `getPixels`가 **문서 전체 합성본**을 읽기 때문에 산출물이 어디 놓이든
 * 구워지는 내용은 같다. 문제는 불투명한 색 레이어가 그 위를 덮어 마감이 안 보이는
 * 것이다. 결함의 크기를 정확히 알아 두는 편이 낫다.
 *
 * **최상위가 전부 그룹이면 앵커가 없어 아무것도 하지 않는다.** 실기에서 그 문서를
 * 만들어 확인했더니 산출물이 **스스로 그룹 밖으로 빠져나와** 최상위에 새 그룹으로
 * 묶였다 — 결과는 정상이다. 왜 그렇게 되는지는 모른다(Photoshop이 앵커 없는 상태에서
 * 어디를 활성으로 잡는지에 달렸다). **관찰이지 설계가 아니므로** 여기 기대지 말 것.
 * 이 경로가 깨지면 "만든 뒤 명시적으로 밖으로 옮기는" 방식이 필요하다.
 */
async function anchorTopLevel(doc) {
  const tops = doc.layers;
  if (!tops || tops.length === 0) return;
  let anchor = null;
  for (let i = 0; i < tops.length; i++) {
    if (!tops[i].layers) { anchor = tops[i]; break; } // .layers가 있으면 그룹이다
  }
  if (!anchor) return;
  await play([selectLayer(anchor.id)]);
}

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
 * Photoshop 전경색을 [r,g,b] 0~255로 읽는다. 없으면 null.
 *
 * 스포이드 대용이다 — **UXP 패널은 문서 캔버스 클릭을 받지 못한다.** 패널 안
 * `<img>`에서 좌표를 잡는 방법도 있으나 표시 영역과 이미지 좌표가 어긋나는지
 * 확인되지 않았다. 사용자가 Photoshop 스포이드로 찍고 이 값을 가져오는 쪽이
 * 좌표 문제가 아예 없고 캔버스에서 직접 찍을 수 있다.
 */
function foregroundRgb() {
  try {
    const c = app.foregroundColor;
    if (!c || !c.rgb) return null;
    const { red, green, blue } = c.rgb;
    if (typeof red !== "number") return null;
    return [red, green, blue];
  } catch (e) {
    return null;
  }
}

/** 프로파일 이름이 실릴 수 있는 속성 후보. `documentProfile`이 순서대로 본다. */
const PROFILE_KEYS = ["colorProfileName", "colorProfile", "profile"];

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
function documentProfile() {
  try {
    return profileOf(app.activeDocument);
  } catch (e) {
    return null;
  }
}

/**
 * 주어진 문서의 색 프로파일 이름. 읽지 못하면 null.
 *
 * `documentProfile`이 활성 문서용이라면 이쪽은 **손에 든 문서**용이다. 적용 경로는
 * 이미 문서 객체를 들고 있어서 활성 문서를 다시 찾을 이유가 없다(배치에서
 * 활성 문서가 대상과 다를 수 있다 — `apply.js`가 그 전제를 적어 뒀다).
 * 속성 이름 후보를 아는 곳은 **여기 하나뿐이어야 한다.**
 */
function profileOf(doc) {
  try {
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
  profileOf,
  foregroundRgb,
  collectLayers,
  selectLayer,
  anchorTopLevel,
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
