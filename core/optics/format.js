/**
 * 필름 포맷과 출력 해상도 — 그레인·할레이션의 물리적 크기 기준.
 *
 * v1의 `grainBlurRadius()`는 긴 변을 3000px로 정규화하고 임의 계수 2.2를 곱했다.
 * 해상도 독립성은 얻지만 물리적 근거가 없고, 무엇보다 **필름 포맷을 모른다.**
 * 같은 Portra 400도 35mm과 120은 최종 이미지에서 입자 크기가 크게 다른데
 * v1은 이를 구분하지 못했다.
 *
 * 실제로는 입자 크기가 **필름면에서 고정**이다. 최종 이미지에서 달라 보이는 것은
 * 확대율 차이 때문이다 — 4×5는 35mm보다 프레임이 3.5배 크니 같은 출력 크기까지
 * 확대할 때 배율이 1/3.5이고, 입자도 그만큼 곱게 보인다.
 *
 *     px_per_mm = 이미지_긴변_px / 프레임_긴변_mm
 *     grain_px  = (유효입자_µm / 1000) × px_per_mm
 *
 * 포맷과 픽셀 치수만으로 성립한다. DPI는 들어가지 않는다 — 인쇄 크기 안내에만 쓴다.
 */

/**
 * 프레임 긴 변 (mm). 실제 노광 면적 기준이며 필름 폭이 아니다
 * (120 필름은 폭이 61mm지만 6×7의 노광 긴 변은 70mm다).
 */
const FORMATS = [
  { id: "35mm", displayName: "35mm", longEdgeMm: 36, note: "36×24mm — 가장 거친 입자" },
  { id: "645", displayName: "6×4.5", longEdgeMm: 56, note: "120 중형. 35mm의 약 0.64배" },
  { id: "66", displayName: "6×6", longEdgeMm: 56, note: "120 중형 정방형" },
  { id: "67", displayName: "6×7", longEdgeMm: 70, note: "120 중형. 35mm의 약 0.51배" },
  { id: "4x5", displayName: "4×5″", longEdgeMm: 127, note: "대형. 35mm의 약 0.28배 — 입자가 거의 안 보인다" },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

/**
 * 그레인 계산에 쓸 긴 변 픽셀의 기준.
 *
 * ⚠️ v2plan 4.5는 "표준 / 고해상" 2단계로 적었지만 **3개로 구현했다.** 두 단계만
 * 두면 "문서 크기 그대로"를 표현할 방법이 없는데, 그것이 물리적으로 옳은 기본값이다.
 * 60MP 문서에 6000px 기준을 적용하면 입자가 실제보다 곱게 나온다.
 *
 * 고정 기준이 필요한 경우는 따로 있다 — **작업 파일과 최종 출력 크기가 다를 때**다.
 * 9504px로 작업하고 2048px로 웹에 올리면 축소 과정에서 입자가 뭉개져 사라진다.
 * 그때 출력 크기를 선언해 두면 그 크기에서 맞는 입자를 만든다.
 */
const REFERENCES = [
  { id: "document", displayName: "문서", longEdge: null, note: "문서 픽셀 그대로. 물리적으로 옳은 기본값" },
  { id: "standard", displayName: "6000px", longEdge: 6000, note: "일반 스캔·DSLR 기준으로 고정" },
  { id: "high", displayName: "9000px", longEdge: 9000, note: "고화소·드럼스캔 기준으로 고정" },
  { id: "custom", displayName: "직접 입력", longEdge: null, note: "최종 출력 긴 변을 직접 지정 (웹 축소본 등)" },
];

const REF_BY_ID = new Map(REFERENCES.map((r) => [r.id, r]));

/** 직접 입력 긴 변의 하한. 이보다 작으면 입자가 사라져 무의미하다. */
const MIN_LONG_EDGE = 256;

/** DPI가 없거나 이상한 파일의 가정값. 인쇄 크기 안내에만 쓴다. */
const ASSUMED_DPI = 300;

function all() {
  return FORMATS;
}

function byId(id) {
  return BY_ID.get(id) || BY_ID.get("35mm");
}

function references() {
  return REFERENCES;
}

function referenceById(id) {
  return REF_BY_ID.get(id) || REF_BY_ID.get("document");
}

/** 감도 슬라이더 범위 (ISO). 로그(스톱) 스케일. */
const MIN_ISO = 50;
const MAX_ISO = 3200;

/**
 * 필름 감도(ISO) → 필름면 유효 입자 지름 (µm). 범위 4~25µm.
 *
 * 입자 크기는 곧 감도다 — 빠른 필름일수록 은염 결정이 굵다. 그래서 추상적인
 * "크기 0~10" 대신 사진가에게 익숙한 ISO로 받는다(todo 0-4). 멱법칙으로 맞춘다:
 *
 *     ISO   50 → 4µm      400 → 10µm (기본)     3200 → 25µm
 *          100 → 6µm      800 → 14µm
 *
 * `10·(ISO/400)^0.44`가 이 앵커들을 통과한다(50→3.98, 100→5.4, 800→13.6, 3200→25).
 *
 * ⚠️ **추정값이다.** 현행 Kodak TDS는 입자 지표로 PGI를 쓰고 구형 RMS
 * granularity와 변환 관계가 없다고 명시돼 있어(v2plan 4.2) 공개 자료에서 µm를
 * 곧바로 얻을 수 없다. 감성 근사다(C3).
 *
 * 예전엔 크기 0~10을 블러 반경으로 썼고 mush 회피로 6µm에 상한을 뒀는데, 그레인을
 * 값 노이즈로 생성하면서(grainfield) 큰 blob이 대비를 유지해 상한이 불필요해졌다.
 */
function micronsForIso(iso) {
  const i = iso < MIN_ISO ? MIN_ISO : iso > MAX_ISO ? MAX_ISO : iso;
  return 10 * Math.pow(i / 400, 0.44);
}

/**
 * 계산에 쓸 긴 변 픽셀.
 *   document — 문서 값
 *   standard/high — 고정값
 *   custom — 사용자 입력. **비었거나 비정상이면 문서 값으로 폴백한다.**
 *            0으로 떨어뜨리면 입자가 조용히 사라지므로, NaN·빈칸·하한 미만을
 *            전부 문서 값으로 되돌린다(그레인이 꺼지는 것보다 정상 크기가 낫다).
 */
function longEdgeFor(doc, referenceId, customLongEdge) {
  const ref = referenceById(referenceId);
  const docEdge = Math.max((doc && doc.width) || 0, (doc && doc.height) || 0) || 6000;

  if (ref.id === "custom") {
    const v = Number(customLongEdge);
    return isFinite(v) && v >= MIN_LONG_EDGE ? v : docEdge;
  }
  if (ref.longEdge) return ref.longEdge;
  return docEdge;
}

/**
 * 그레인 크기를 픽셀로 환산한다.
 *
 * @param {object} doc     활성 문서 (width/height)
 * @param {object} medium  { format, reference, customLongEdge }
 * @param {number} iso     필름 감도 (ISO 50~3200)
 * @returns {{px:number, pxPerMm:number, microns:number, subPixel:boolean, amountScale:number}}
 *   px          가우시안 블러 반경으로 쓸 값
 *   subPixel    1px 미만 — 블러로 표현할 수 없다
 *   amountScale 서브픽셀일 때 노이즈 amount에 곱할 계수 (0~1)
 */
function grainSize(doc, medium, iso) {
  const m = medium || {};
  const fmt = byId(m.format);
  const microns = micronsForIso(iso);
  const longEdge = longEdgeFor(doc, m.reference, m.customLongEdge);
  const pxPerMm = longEdge / fmt.longEdgeMm;
  const px = (microns / 1000) * pxPerMm;

  // 1px 미만은 가우시안 블러로 표현할 수 없다. 블러를 끄고 **강도로 환산**한다 —
  // 픽셀보다 고운 입자는 그 자리에서 평균되어 변조 진폭이 줄어드는 것이 실제
  // 거동이므로, 크기를 못 줄이는 대신 세기를 줄이는 편이 물리에 가깝다.
  const subPixel = px < 1;
  return {
    px,
    pxPerMm,
    microns,
    longEdge, // 격자 블러 해상도 배율 등에 쓴다(custom 기준 포함한 실제 값)
    subPixel,
    amountScale: subPixel ? Math.max(0.25, px) : 1,
  };
}

/**
 * 다이클라우드 특성 — 그레인 한 존이 쌓을 레이어의 채널 진폭·클럼프.
 *
 * 균일 노이즈 + 단일 블러는 같은 크기의 둥근 점만 만든다. 실제 필름은 두 가지가
 * 다르다.
 *
 *   1. **채널별 노이즈 진폭이 다르다.** Vision3 500T 스캔 4장 실측 결과 채널차는
 *      입자 **크기**가 아니라 **진폭**이었다 — 상관길이는 세 채널이 사실상 같고
 *      (R 1.2 / G 0.8 / B 0.8 px), RMS가 R 1.23 · G 1.0 · **B 1.76**로 청색이
 *      가장 시끄러웠다. 텅스텐 필름을 주광에서 찍어 청감층이 얇게 노광되고 반전
 *      증폭돼 청색 노이즈가 커진 것이다. (처음엔 청색을 더 **조대**하게 만들었는데
 *      실측이 지지하지 않았다 — 크기가 아니라 세기다.)
 *   2. **밀도 요동이 광대역이다.** 미세 해시 위에 큰 상관길이의 덩어리(클럼프)가
 *      겹친다. 단일 주파수가 아니라 옥타브의 합이다.
 *
 * @param {number} px      format.grainSize의 기준 입자 px (클럼프 반경에만 쓴다)
 * @param {object} grain   { dyeSpread, clump } 0~100
 * @returns {{ amps:{r,g,b}, clumpRadius:number, clumpScale:number }}
 */
function dyeClouds(px, grain) {
  const g = grain || {};
  const spread = clamp01((g.dyeSpread == null ? 0 : g.dyeSpread) / 100);
  // 실측 진폭비(spread 100): R 1.23 · G 1.0 · B 1.76. spread로 항등(1.0)에서 보간.
  const amp = (f) => 1 + (f - 1) * spread;
  const amps = { r: amp(1.23), g: 1.0, b: amp(1.76) };

  const clumpScale = clamp01((g.clump == null ? 0 : g.clump) / 100);
  return { amps, clumpRadius: px * 2.6, clumpScale };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 35mm를 1.0으로 놓은 포맷 배율.
 *
 * 할레이션에 쓴다. 할레이션도 그레인과 같은 물리다 — 빛이 유제와 베이스에서
 * 산란하는 거리는 **필름면에서 고정**이므로, 큰 포맷일수록 확대율이 낮아 최종
 * 이미지에서 좁게 보인다.
 *
 * 그레인처럼 절대 물리 단위로 다시 쓰지 않고 배율로 두는 이유는 **기존 프리셋을
 * 깨지 않기 위해서**다. 할레이션 반경은 이미 긴 변 대비 %로 저장돼 해상도
 * 독립적이었고, 35mm에서 배율이 1.0이라 기존 값이 그대로 재현된다.
 */
function relativeScale(formatId) {
  return FORMATS[0].longEdgeMm / byId(formatId).longEdgeMm;
}

/**
 * 인쇄 크기 안내 문자열. 그레인 계산에는 쓰이지 않는다.
 * DPI가 없거나 비정상이면 300으로 가정한다.
 */
function printSize(doc) {
  const dpi = doc.resolution > 1 ? doc.resolution : ASSUMED_DPI;
  const w = (doc.width / dpi) * 2.54;
  const h = (doc.height / dpi) * 2.54;
  const assumed = doc.resolution > 1 ? "" : " (가정)";
  return `${w.toFixed(1)}×${h.toFixed(1)}cm @ ${Math.round(dpi)}dpi${assumed}`;
}

module.exports = {
  FORMATS,
  REFERENCES,
  MIN_LONG_EDGE,
  ASSUMED_DPI,
  all,
  byId,
  references,
  referenceById,
  MIN_ISO,
  MAX_ISO,
  micronsForIso,
  longEdgeFor,
  grainSize,
  dyeClouds,
  relativeScale,
  printSize,
};
