/**
 * 할레이션 시뮬레이션.
 *
 * 강한 광원이 필름 유제를 통과해 베이스 층에서 반사되어 되돌아오며 광원 주위에
 * 붉은 번짐을 만드는 현상. 안티할레이션 층이 제거된 필름의 대표적 특징.
 *
 * 파이프라인:
 *   보이는 레이어 스탬프
 *   → Levels로 임계값 이상 하이라이트만 추출
 *   → R/G/B 각각 다른 반경으로 블러 (레드가 가장 넓게 퍼진다)
 *   → Hue/Sat colorize로 오렌지-레드 틴트
 *   → Screen 합성
 *
 * 채널별 반경 차등이 없으면 단순 글로우로 보인다. 이 단계가 핵심.
 */

const ps = require("./ps");
const { play } = require("./ps");

/** 임계값 이상만 남기고 나머지를 검정으로 눌러 하이라이트를 추출한다. */
function extractHighlights(threshold) {
  return {
    _obj: "levels",
    presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
    adjustment: [
      {
        _obj: "levelsAdjustment",
        channel: { _ref: "channel", _enum: "ordinal", _value: "composite" },
        input: [Math.round(threshold), 255],
      },
    ],
  };
}

function colorize(hue, saturation) {
  return {
    _obj: "hueSaturation",
    presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
    colorize: true,
    adjustment: [
      {
        _obj: "hueSatAdjustmentV2",
        hue: Math.round(hue),
        saturation: Math.round(saturation),
        lightness: 0,
      },
    ],
  };
}

async function apply(doc, halation) {
  if (!halation.enabled || halation.strength <= 0) return;

  const baseRadius = ps.percentToPixels(doc, halation.radius);
  const spread = halation.channelSpread;

  // 스탬프 + 하이라이트 추출
  await play([
    ps.stampVisible(),
    ps.renameLayer("FilmSim · Halation"),
    extractHighlights(halation.threshold),
  ]);

  // 채널별 블러. 반경이 사실상 0인 채널은 건너뛴다.
  const channels = [
    ["red", spread.r],
    ["grain", spread.g], // Photoshop 채널 열거자에서 green은 "grain"
    ["blue", spread.b],
  ];

  for (const [channel, factor] of channels) {
    const radius = baseRadius * factor;
    if (radius < 0.15) continue;
    await play([
      ps.selectChannel(channel),
      ps.gaussianBlur(radius),
    ]);
  }

  // 합성 채널로 복귀 후 틴트와 블렌드 적용
  await play([
    ps.selectChannel("RGB"),
    colorize(halation.tintHue, halation.tintSaturation),
    ps.setLayerBlend("screen", halation.strength),
  ]);
}

module.exports = { apply };
