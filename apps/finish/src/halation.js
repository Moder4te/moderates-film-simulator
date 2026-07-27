/**
 * 할레이션 시뮬레이션 — 다중스케일 블룸.
 *
 * 강한 광원이 필름 유제를 통과해 베이스 층에서 반사되어 되돌아오며 광원 주위에
 * 붉은 번짐을 만드는 현상. 안티할레이션 층이 제거된 필름의 대표적 특징.
 *
 * ── 왜 단일 가우시안이 아닌가 ───────────────────────────────────────────
 *
 * 예전엔 채널당 가우시안 하나로 번졌다. 한 스케일뿐이라 **핫코어와 블리딩을 동시에**
 * 못 냈다 — 반경을 키우면 코어가 뭉개지고 줄이면 번짐이 사라진다. 실제 할레이션의
 * PSF는 밝은 코어 + 긴 꼬리다. 여러 반경 가우시안의 합이 이 모양을 근사한다.
 *
 * 파이프라인:
 *   보이는 레이어 스탬프 → Levels로 하이라이트만 추출 (원본 한 장)
 *   → 스케일마다: 복제 → 채널별 블러(R 최대) → colorize → Screen(가중 불투명도)
 *   → 추출 원본 삭제
 *
 *   · **핫코어**  — 타이트 스케일(×0.4). 광원에 밀착한 밝은 번짐.
 *   · **중간**    — ×1.3. 코어와 블리딩을 이어 링이 갈라지지 않게 한다.
 *   · **블리딩**  — 광역 스케일(×4). 넓게 퍼지는 붉은 헤일로.
 *
 * PS의 GPU 가우시안을 재사용한다(batchPlay). 추출본은 DOM duplicate로 복제한다.
 */

const { app } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");

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

/** id로 레이어를 선택한다(가시성은 그대로). 활성 레이어를 명시적으로 고정한다. */
function selectLayer(id) {
  return {
    _obj: "select",
    _target: [{ _ref: "layer", _id: id }],
    makeVisible: false,
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

async function apply(doc, halation, formatId, prefix) {
  if (!halation.enabled || halation.strength <= 0) return;

  // 포맷 배율 — 산란 거리는 필름면에서 고정이므로 큰 포맷일수록 좁게 보인다.
  // 35mm에서 1.0이라 기존 프리셋의 반경 감각이 그대로 재현된다(format.js 참조).
  const baseRadius =
    ps.percentToPixels(doc, halation.radius) * format.relativeScale(formatId);
  const spread = halation.channelSpread;

  const core = halation.core == null ? 60 : halation.core;
  const bleed = halation.bleed == null ? 50 : halation.bleed;

  // 스케일 = { 반경 배율, 가중(0~1), 블렌드 }. 가중은 strength에 다시 곱해진다.
  // 중간은 코어·블리딩을 이어 주는 다리라 둘의 평균으로 자동 산출한다.
  //
  // 핫코어는 **Color Dodge**다(사용자 실측 — Screen보다 자연스럽다). 닷지는 코어를
  // 더 세게 태워 광원에 밀착한 밝은 번짐을 만든다. 넓은 스케일은 Screen이라야
  // 부드럽게 쌓인다(닷지로 넓게 태우면 하이라이트가 뭉텅 날아간다).
  const scales = [
    { name: "Core", mul: 0.4, w: core / 100, blend: "colorDodge" },
    { name: "Mid", mul: 1.3, w: (core + bleed) / 200, blend: "screen" },
    { name: "Bleed", mul: 4.0, w: bleed / 100, blend: "screen" },
  ];

  // 하이라이트 추출본 한 장. 각 스케일이 여기서 복제돼 나간다.
  //
  // stampVisible은 디스크립터를 **두 개** 돌려준다(빈 레이어 생성 + 병합).
  // 병합만 내면 결과가 활성 레이어 안으로 들어가 배경 원본을 덮는다 — ps.js 참조.
  await play([
    ...ps.stampVisible(),
    ps.renameLayer(`${prefix} · Halation src`),
    extractHighlights(halation.threshold),
  ]);
  const base = app.activeDocument.activeLayers[0];
  const baseId = base.id;

  const channels = [
    ["red", spread.r],
    ["grain", spread.g], // Photoshop 채널 열거자에서 green은 "grain"
    ["blue", spread.b],
  ];

  for (const sc of scales) {
    const opacity = halation.strength * sc.w;
    if (opacity < 1) continue; // 기여가 없는 스케일은 건너뛴다

    // 추출 원본을 다시 선택해 복제한다(직전 루프가 활성 레이어를 바꿔 놨다).
    await play([selectLayer(baseId)]);
    const dup = await base.duplicate();
    await play([selectLayer(dup.id), ps.renameLayer(`${prefix} · Halation ${sc.name}`)]);

    // 채널별 블러 — 스케일 배율 × 채널 차등(R 최대). 사실상 0인 채널은 건너뛴다.
    for (const [channel, factor] of channels) {
      const radius = baseRadius * sc.mul * factor;
      if (radius < 0.15) continue;
      await play([ps.selectChannel(channel), ps.gaussianBlur(radius)]);
    }

    await play([
      ps.selectChannel("RGB"),
      colorize(halation.tintHue, halation.tintSaturation),
      ps.setLayerBlend(sc.blend, clamp(opacity, 1, 100)),
    ]);
  }

  // 추출 원본은 Normal 블랙이라 두면 원본 이미지를 덮는다. 삭제한다.
  await base.delete();
}

module.exports = { apply };
