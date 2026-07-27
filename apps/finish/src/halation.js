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

/** HSV(V=1)로 틴트 색을 만든다. hue 0~60(붉은-오렌지)에서 R=1이 된다. */
function hsvTint(hue, sat) {
  const s = sat < 0 ? 0 : sat > 100 ? 1 : sat / 100;
  const h = ((((hue % 360) + 360) % 360)) / 60;
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  let r, g, b;
  if (h < 1) { r = c; g = x; b = 0; }
  else if (h < 2) { r = x; g = c; b = 0; }
  else if (h < 3) { r = 0; g = c; b = x; }
  else if (h < 4) { r = 0; g = x; b = c; }
  else if (h < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

/**
 * 할레이션 소스 = **적색 채널 구동** 하이라이트를 **오렌지-레드로 색칠해** 새
 * 레이어에 putPixels한다.
 *
 * 두 번 고쳤다.
 *
 *   ① 예전엔 합성 휘도 >임계값으로 뽑았다 — 포화 적색 네온(휘도 ~76)이 임계에 안
 *      걸려 아예 블룸을 안 했다. 그래서 R 채널로 추출한다(적색광이 베이스에서
 *      반사되는 물리 그대로). 붉은·흰 광원은 잡고 파랑·초록은 무시한다.
 *   ② 예전엔 강도를 **회색**으로 담고 뒤에서 colorize로 색을 입혔다. 그런데
 *      colorize는 명도만 보고 레이어를 단색으로 덮어, 채널별 블러가 만든 색
 *      분리(다크 레드 링)를 파괴하고 밋밋한 오렌지 안개로 만든다. 그래서 **소스
 *      자체를 오렌지-레드로** 만든다. 채널 확산차(R 최대)가 그대로 살아 바깥은
 *      순수 붉은 링, 안은 오렌지가 된다. 색은 tintHue/Sat에서 나온다.
 */
async function buildRedSource(doc, threshold, hue, sat, prefix) {
  const tint = hsvTint(hue, sat);
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
      out[o] = v * tint[0];
      out[o + 1] = v * tint[1];
      out[o + 2] = v * tint[2];
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

  // 스케일 = { 반경 배율, 가중(0~1), 블렌드, 코어 화이트닝 여부 }.
  // 중간은 코어·블리딩을 이어 주는 다리라 둘의 평균으로 자동 산출한다.
  //
  //   · **Core**  — 타이트(×0.3), **Color Dodge**. 실제 할레이션의 코어는 뜨거운
  //     흰색으로 날아간다. 소스는 오렌지-레드라 여기만 colorize로 채도를 죽여
  //     흰색에 가깝게 만든다(whitenSat). 붉은 색은 주변 헤일로가 담당.
  //   · **Mid**   — ×1.1, **Linear Dodge(Add)**. 붉은 링의 본체다. Screen이면
  //     압축돼 경계가 뭉개지고 살몬으로 희석되므로 Add로 진하게, 반경을 좁혀
  //     경계를 세운다. colorize 안 한다 — 채널 확산차가 만든 링을 그대로 살린다.
  //   · **Bleed** — ×4.0, **Linear Dodge(Add)**. 넓은 헤일로. Add로 암부·중간톤
  //     위 채도 높은 붉은빛을 유지(Screen은 살몬으로 희석).
  const scales = [
    { name: "Core", mul: 0.3, w: core / 100, blend: "colorDodge", whitenSat: halation.tintSaturation * 0.1 },
    { name: "Mid", mul: 1.1, w: (core + bleed) / 180, blend: "linearDodge", whitenSat: null },
    { name: "Bleed", mul: 4.0, w: bleed / 100, blend: "linearDodge", whitenSat: null },
  ];

  // 적색 구동 + 오렌지-레드로 색칠한 하이라이트 소스 한 장. 각 스케일이 복제해 간다.
  const base = await buildRedSource(
    doc,
    halation.threshold,
    halation.tintHue,
    halation.tintSaturation,
    prefix
  );
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

    const cmds = [ps.selectChannel("RGB")];
    // 코어만 화이트닝(colorize로 채도↓). 중간·블리딩은 소스 색을 그대로 둔다 —
    // colorize를 걸면 채널 확산차가 만든 붉은 링이 단색 안개로 뭉개진다.
    if (sc.whitenSat != null) cmds.push(colorize(halation.tintHue, sc.whitenSat));
    cmds.push(ps.setLayerBlend(sc.blend, clamp(opacity, 1, 100)));
    await play(cmds);
  }

  // 추출 원본은 Normal 블랙이라 두면 원본 이미지를 덮는다. 삭제한다.
  await base.delete();
}

module.exports = { apply };
