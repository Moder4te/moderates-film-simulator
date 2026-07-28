/**
 * CMYK 기반 필름 컬러 그레이딩.
 *
 * RGB 문서 모드를 유지한 채 Selective Color 조정 레이어로 CMY 축을 제어한다.
 * Selective Color는 내부적으로 CMYK 좌표계에서 동작하므로 문서를 CMYK 모드로
 * 변환할 필요가 없다. 모드 변환은 색역 손실이 크므로 사용하지 않는다.
 */

const { play, renameLayer } = require("./ps");
const { SELECTIVE_COLOR_RANGES } = require("./params");

function pct(value) {
  return { _unit: "percentUnit", _value: value };
}

function selectiveColorLayer(grading) {
  const corrections = SELECTIVE_COLOR_RANGES.map((range) => {
    const v = grading.selectiveColor[range] || { c: 0, m: 0, y: 0, k: 0 };
    return {
      _obj: "colorCorrection",
      colors: { _enum: "colors", _value: range },
      cyan: pct(v.c),
      magenta: pct(v.m),
      yellowColor: pct(v.y),
      blackColor: pct(v.k),
    };
  });

  return {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: {
      _obj: "adjustmentLayer",
      type: {
        _obj: "selectiveColor",
        presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
        method: { _enum: "correctionMethod", _value: grading.method },
        colorCorrection: corrections,
      },
    },
  };
}

/**
 * 특성곡선의 토우/숄더 + 채널 게인을 하나의 커브 조정 레이어로 만든다.
 *
 * toe:      암부를 들어올려 검정이 완전히 눌리지 않게 한다 (필름 특유의 lifted black).
 * shoulder: 명부를 눌러 하이라이트 롤오프를 만든다.
 */
function curveLayer(grading) {
  const { toe, shoulder, channelGain } = grading;

  // 토우는 암부 컨트롤 포인트를 위로, 숄더는 명부 컨트롤 포인트를 아래로 민다.
  const toeLift = (toe / 100) * 24;
  const shoulderDrop = (shoulder / 100) * 24;

  const composite = [
    { _obj: "paint", horizontal: 0, vertical: toeLift },
    { _obj: "paint", horizontal: 64, vertical: 64 + toeLift * 0.5 },
    { _obj: "paint", horizontal: 192, vertical: 192 - shoulderDrop * 0.5 },
    { _obj: "paint", horizontal: 255, vertical: 255 - shoulderDrop },
  ];

  const adjustment = [
    {
      _obj: "curvesAdjustment",
      channel: { _ref: "channel", _enum: "ordinal", _value: "composite" },
      curve: composite,
    },
  ];

  // 채널 게인은 각 채널의 중간점을 이동시켜 구현한다.
  // Photoshop 채널 열거자에서 green은 "grain"이다.
  const channelMap = { r: "red", g: "grain", b: "blue" };
  for (const key of ["r", "g", "b"]) {
    const gain = channelGain[key];
    if (gain === 1.0) continue;
    const mid = Math.max(0, Math.min(255, 128 * gain));
    adjustment.push({
      _obj: "curvesAdjustment",
      channel: { _ref: "channel", _enum: "channel", _value: channelMap[key] },
      curve: [
        { _obj: "paint", horizontal: 0, vertical: 0 },
        { _obj: "paint", horizontal: 128, vertical: mid },
        { _obj: "paint", horizontal: 255, vertical: 255 },
      ],
    });
  }

  return {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: {
      _obj: "adjustmentLayer",
      type: {
        _obj: "curves",
        presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
        adjustment,
      },
    },
  };
}

function hasCurveWork(grading) {
  if (grading.toe !== 0 || grading.shoulder !== 0) return true;
  const g = grading.channelGain;
  return g.r !== 1.0 || g.g !== 1.0 || g.b !== 1.0;
}

/**
 * 크로스토크 매트릭스를 Channel Mixer 조정 레이어로 만든다.
 * matrix[출력][소스], 단위 %. Photoshop 채널 매트릭스에서 green 키는 "grain"이다.
 */
function channelMixerLayer(crosstalk) {
  const m = crosstalk.matrix;
  const row = (out) => ({
    _obj: "channelMatrix",
    red: pct(m[out][0]),
    grain: pct(m[out][1]),
    blue: pct(m[out][2]),
    constant: pct(0),
  });

  return {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: {
      _obj: "adjustmentLayer",
      type: {
        _obj: "channelMixer",
        presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
        monochromatic: false,
        red: row(0),
        grain: row(1),
        blue: row(2),
      },
    },
  };
}

/** 매트릭스가 항등이면 크로스토크 레이어를 만들 필요가 없다. */
function isIdentityMatrix(m) {
  const id = [[100, 0, 0], [0, 100, 0], [0, 0, 100]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (m[i][j] !== id[i][j]) return false;
  return true;
}

async function apply(grading) {
  if (!grading.enabled) return;

  if (hasCurveWork(grading)) {
    await play([curveLayer(grading), renameLayer("FilmSim · Curve")]);
  }

  // 크로스토크는 색역별 보정 이전에 둔다. 채널 간섭이 먼저 일어난 위에
  // Selective Color가 얹히는 편이 유제 물리에 가깝다.
  const ct = grading.crosstalk;
  if (ct && ct.enabled && !isIdentityMatrix(ct.matrix)) {
    await play([channelMixerLayer(ct), renameLayer("FilmSim · Crosstalk")]);
  }

  await play([selectiveColorLayer(grading), renameLayer("FilmSim · CMYK Grade")]);
}

module.exports = { apply };
