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

const { app, imaging } = require("photoshop");
const ps = require("../lib/host/ps");
const { play } = require("../lib/host/ps");
const format = require("../lib/core/optics/format");

/**
 * 할레이션 소스 = **적색 채널 구동** 하이라이트. 새 레이어에 putPixels한다.
 *
 * 예전엔 합성 휘도 >임계값으로 뽑았다. 근본 결함이었다 — 할레이션은 물리적으로
 * **적색 현상**(적색광이 유제를 통과해 베이스에서 반사)인데, 포화 적색 네온
 * (R255 G0 B0)은 휘도가 ~76뿐이라 임계에 안 걸려 아예 블룸을 안 했다. 그래서
 * 붉은 오염이 안 생겼다(작례 실측 대비 붉은 링 절반, 붉은 광원 2.8% 누락).
 *
 * 이제 R 채널로 smoothstep 추출한다. 붉은·흰 광원(R 높음)은 잡히고 파랑·초록
 * 광원(R 낮음)은 안 잡힌다 — 할레이션이 붉은 이유 그 자체다. 강도만 회색으로
 * 담고 색(오렌지-레드)은 뒤의 colorize가 준다.
 */
async function buildRedSource(doc, threshold, prefix) {
  await play([ps.makePixelLayer(), ps.renameLayer(`${prefix} · Halation src`)]);
  const layerId = app.activeDocument.activeLayers[0].id;

  const px = await imaging.getPixels({ documentID: doc.id, colorSpace: "RGB" });
  let outImage = null;
  try {
    const w = px.imageData.width;
    const h = px.imageData.height;
    const comps = px.imageData.components;
    const data = await px.imageData.getData({ chunky: true });
    const bytes = data.BYTES_PER_ELEMENT;
    const maxV = bytes === 2 ? 32768 : 255; // PS 16bit는 0~32768
    const t = (threshold / 255) * maxV;
    // **완만한 knee.** 임계에서 max까지 다 올라가야 최대면(smoothstep(t,max)) 중간
    // 밝기 붉은 소스(네온 R 중앙 ~0.69)가 잡혀도 거의 안 블룸한다. 실측에서
    // 붉은 링이 작례의 절반이었던 원인. 임계 위 절반 지점에서 full에 도달시켜
    // 중간밝기 붉은 소스도 확실히 블룸하게 한다.
    const knee = Math.max(1, (maxV - t) * 0.5);

    const out = new data.constructor(w * h * comps);
    for (let p = 0; p < w * h; p++) {
      const o = p * comps;
      // R 기반 강도(완만 knee + smoothstep). 채널 순서 RGB(getPixels colorSpace:"RGB").
      let s = (data[o] - t) / knee;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      s = s * s * (3 - 2 * s);
      const v = s * maxV;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      if (comps > 3) out[o + 3] = maxV; // 불투명
    }

    outImage = await imaging.createImageDataFromBuffer(out, {
      width: w,
      height: h,
      components: comps,
      componentSize: bytes === 2 ? 16 : 8,
      colorSpace: "RGB",
    });
    await imaging.putPixels({
      documentID: doc.id,
      layerID: layerId,
      targetBounds: { left: 0, top: 0, width: w, height: h },
      imageData: outImage,
    });
  } finally {
    if (outImage) outImage.dispose();
    px.imageData.dispose();
  }

  return app.activeDocument.activeLayers[0];
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

  // 스케일 = { 반경 배율, 가중(0~1), 블렌드, 채도 배율 }. 가중은 strength에 곱해진다.
  // 중간은 코어·블리딩을 이어 주는 다리라 둘의 평균으로 자동 산출한다.
  //
  // 핫코어는 **Color Dodge + 거의 무채색**이다. 실제 할레이션의 코어는 뜨거운
  // 흰색으로 날아가고, 붉은 색은 그 주변 헤일로다. colorize로 코어까지 오렌지로
  // 물들이면 흰색이 못 돼 닷지가 흰색으로 못 태운다(코어가 약해 보이던 원인).
  // 그래서 코어는 채도를 죽여(satMul 0.1) 흰색에 가깝게 두고 타이트하게(×0.3)
  // 집중시킨다. 붉은 틴트는 중간·블리딩(Screen)이 담당한다.
  const scales = [
    { name: "Core", mul: 0.3, w: core / 100, blend: "colorDodge", satMul: 0.1 },
    { name: "Mid", mul: 1.3, w: (core + bleed) / 200, blend: "screen", satMul: 0.6 },
    { name: "Bleed", mul: 4.0, w: bleed / 100, blend: "screen", satMul: 1.0 },
  ];

  // 적색 구동 하이라이트 소스 한 장(회색 강도). 각 스케일이 여기서 복제돼 나간다.
  const base = await buildRedSource(doc, halation.threshold, prefix);
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
      colorize(halation.tintHue, halation.tintSaturation * sc.satMul),
      ps.setLayerBlend(sc.blend, clamp(opacity, 1, 100)),
    ]);
  }

  // 추출 원본은 Normal 블랙이라 두면 원본 이미지를 덮는다. 삭제한다.
  await base.delete();
}

module.exports = { apply };
