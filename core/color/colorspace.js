/**
 * 표시용 색공간 변환 — 작업 색공간 → sRGB.
 *
 * 패널 미리보기는 픽셀을 JPEG로 인코딩해 <img>에 넣는데, UXP는 그 이미지를
 * **sRGB로 간주해 표시한다.** 프로파일을 붙일 방법이 없다. 그래서 문서가
 * ProPhoto RGB면 숫자를 그대로 넘길 경우 어둡게 보인다 — ProPhoto γ1.8은 같은
 * 광량을 sRGB보다 낮은 값으로 인코딩하기 때문이다(18% 그레이: ProPhoto 0.386,
 * sRGB 0.46). 0.386을 sRGB로 해석하면 광량이 0.124로 읽혀 약 2/3스톱 어두워진다.
 *
 * v1에서도 있던 문제지만 8bit sRGB로 작업하면 드러나지 않는다. v2는 ProPhoto가
 * 전제라 반드시 변환해야 한다.
 *
 * 변환 경로: 인코딩 해제 → 원색 행렬 → XYZ → (색순응) → sRGB 원색 → sRGB 인코딩.
 * 행렬 곱은 모듈 로드 시 한 번 계산한다 — 상수를 손으로 곱해 적어두면 틀렸을 때
 * 알아채기 어렵다.
 */

function mul3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

// ProPhoto(ROMM) D50 → XYZ D50
const PROPHOTO_TO_XYZ_D50 = [
  [0.7976749, 0.1351917, 0.0313534],
  [0.2880402, 0.7118741, 0.0000857],
  [0.0, 0.0, 0.825621],
];

// XYZ D50 → 선형 sRGB (Bradford 색순응 포함)
const XYZ_D50_TO_SRGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
];

// Adobe RGB (1998) D65 → XYZ D65
const ADOBE_TO_XYZ_D65 = [
  [0.5767309, 0.185554, 0.1881852],
  [0.2973769, 0.6273491, 0.0752741],
  [0.0270343, 0.0706872, 0.9911085],
];

// XYZ D65 → 선형 sRGB
const XYZ_D65_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

function invert3(m) {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("colorspace: 역행렬이 존재하지 않습니다");
  const inv = 1 / det;
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

const M_PROPHOTO_TO_SRGB = mul3(XYZ_D50_TO_SRGB, PROPHOTO_TO_XYZ_D50);
const M_ADOBE_TO_SRGB = mul3(XYZ_D65_TO_SRGB, ADOBE_TO_XYZ_D65);
const M_SRGB_TO_PROPHOTO = invert3(M_PROPHOTO_TO_SRGB);

/** ROMM RGB 인코딩 해제. 0 부근에 선형 구간이 있다. */
function prophotoDecode(v) {
  return v < 0.031248 ? v / 16 : Math.pow(v, 1.8);
}

/** Adobe RGB (1998) 감마 563/256. */
function adobeDecode(v) {
  return Math.pow(v, 2.19921875);
}

/** 선형 → sRGB 인코딩. */
function srgbEncode(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB 인코딩 해제. */
function srgbDecode(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** ROMM RGB 인코딩. prophotoDecode의 역. */
function prophotoEncode(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v < 0.001953 ? v * 16 : Math.pow(v, 1 / 1.8);
}

function makeConverter(matrix, decode) {
  const m = matrix;
  return function convert(r, g, b, out) {
    const lr = decode(r);
    const lg = decode(g);
    const lb = decode(b);
    out[0] = srgbEncode(m[0][0] * lr + m[0][1] * lg + m[0][2] * lb);
    out[1] = srgbEncode(m[1][0] * lr + m[1][1] * lg + m[1][2] * lb);
    out[2] = srgbEncode(m[2][0] * lr + m[2][1] * lg + m[2][2] * lb);
  };
}

/** 변환이 필요 없을 때. */
function passthrough(r, g, b, out) {
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

const CONVERTERS = {
  prophoto: makeConverter(M_PROPHOTO_TO_SRGB, prophotoDecode),
  adobergb: makeConverter(M_ADOBE_TO_SRGB, adobeDecode),
};

/**
 * 문서 프로파일 이름으로 표시용 변환기를 고른다.
 *
 * 이름을 모르거나 sRGB면 통과 변환기를 준다 — 잘못 변환하는 것보다 그대로 두는
 * 편이 낫다. 프로파일 이름은 batchPlay의 문서 descriptor에서 읽는다.
 */
function displayConverter(profileName) {
  const n = String(profileName || "").toLowerCase();
  if (n.includes("prophoto") || n.includes("romm")) return CONVERTERS.prophoto;
  if (n.includes("adobe rgb")) return CONVERTERS.adobergb;
  return passthrough;
}

/**
 * 작업 색공간 점검 — **엔진이 무엇을 전제하는지**를 코드로 적어 둔 곳.
 *
 * `film.js`는 입력 픽셀을 `L = v^1.8`로 되돌린다. 조건 분기가 없고, `apply.js`도
 * `getPixels({colorSpace:"RGB"})`로 문서 원본 값을 그대로 받는다. 즉 파이프라인은
 * **문서가 ProPhoto(ROMM, γ1.8)라고 무조건 가정한다.** 아니면 두 가지가 동시에 틀어진다.
 *
 *   1. **노광 앵커가 밀린다.** 18% 그레이가 ProPhoto에서는 0.3857로 인코딩되는데
 *      sRGB에서는 0.4614다. 그대로 넣으면 H가 +0.47스톱 밀려 필름 곡선의 **다른
 *      구간**을 쓰게 된다 — 발끝·어깨가 엉뚱한 자리에 걸린다.
 *   2. **암부가 더 심하게 틀어진다.** 오차가 상수가 아니라 어두울수록 커진다.
 *      sRGB 문서는 기준 그레이가 +0.47스톱인데 **3스톱 아래는 +0.75스톱**,
 *      Adobe RGB는 +0.45 대 **+0.99**다. 즉 톤 곡선 자체가 휜다.
 *
 * 원색도 다르지만(채널 분리가 달라진다) 그건 여기서 수치로 말하기 어렵고, 위 둘만으로
 * 충분히 경고가 된다.
 *
 * **막지 않고 알리기만 한다.** 8비트 경고와 같은 방침이다 — 사용자가 알고 하는
 * 작업일 수 있다. 다만 "왜 색이 이상한지"는 알려 줘야 한다.
 *
 * 순수 함수다. 호스트를 보지 않으므로 node에서 그대로 검증된다(`tools/check-tone.js`).
 *
 * @param {string|null} profileName 문서 프로파일 이름. 못 읽었으면 null
 * @returns {{ok: boolean, known: boolean, kind: string, midGrayStops: number,
 *            shadowStops: number, message: string|null}}
 */
function workingSpaceCheck(profileName) {
  const n = String(profileName || "").toLowerCase();
  const known = n.length > 0;

  if (n.includes("prophoto") || n.includes("romm")) {
    return { ok: true, known: true, kind: "prophoto", midGrayStops: 0, shadowStops: 0, message: null };
  }

  // 엔진이 v를 어떻게 읽는지(=v^1.8) 대 실제 공간이 뜻하는 선형값의 차이를
  // **스톱으로** 잰다. 두 지점을 보는 이유는 오차가 상수가 아니기 때문이다.
  function stops(decode, linear) {
    const v = encodeWith(decode, linear); // 그 공간에서 이 선형값의 인코딩값
    const assumed = Math.pow(v, 1.8); // 엔진이 읽는 선형값
    return Math.log2(assumed / linear);
  }

  let kind = "unknown";
  let decode = null;
  if (n.includes("srgb")) {
    kind = "srgb";
    decode = srgbDecode;
  } else if (n.includes("adobe rgb")) {
    kind = "adobergb";
    decode = adobeDecode;
  }

  if (!decode) {
    return {
      ok: false,
      known,
      kind,
      midGrayStops: 0,
      shadowStops: 0,
      message: known
        ? `문서 프로파일이 "${profileName}"입니다. 엔진은 ProPhoto(γ1.8)를 전제하므로 ` +
          "노광 기준과 암부가 어긋날 수 있습니다. 편집 → 프로파일 변환으로 " +
          "ProPhoto RGB로 바꾸고 적용하세요."
        : "문서 프로파일을 읽지 못했습니다. 엔진은 ProPhoto(γ1.8)를 전제합니다 — " +
          "다른 색공간이면 노광 기준이 어긋납니다.",
    };
  }

  const mid = stops(decode, 0.18);
  const shadow = stops(decode, 0.18 / 8); // 기준 그레이에서 3스톱 아래
  return {
    ok: false,
    known: true,
    kind,
    midGrayStops: mid,
    shadowStops: shadow,
    message:
      `문서가 ${profileName}입니다. 엔진은 ProPhoto(γ1.8)를 전제하므로 노광 기준이 ` +
      `${mid >= 0 ? "+" : ""}${mid.toFixed(2)}스톱, 암부(-3스톱 지점)가 ` +
      `${shadow >= 0 ? "+" : ""}${shadow.toFixed(2)}스톱 어긋납니다. ` +
      "편집 → 프로파일 변환으로 ProPhoto RGB로 바꾸고 적용하세요.",
  };
}

/**
 * 선형값을 그 공간의 인코딩값으로. `decode`의 역을 이분법으로 구한다.
 *
 * sRGB·Adobe RGB의 인코딩 함수를 각각 따로 두는 대신 역함수를 수치로 푼다 —
 * 점검용으로 공간마다 두 번씩만 부르므로 비용이 문제되지 않고, **decode 하나만
 * 맞으면 되니 인코딩 쪽 오타로 조용히 틀릴 여지가 없다.**
 */
function encodeWith(decode, linear) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (decode(mid) < linear) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * sRGB → ProPhoto. 팔레트 스와치처럼 **sRGB로 정의된 참조색**을 필름 LUT에
 * 통과시킬 때 쓴다. LUT은 ProPhoto 기준으로 구워졌으므로 그냥 넣으면 엉뚱한
 * 격자 위치를 조회하게 된다.
 */
function srgbToProPhoto(r, g, b, out) {
  const lr = srgbDecode(r);
  const lg = srgbDecode(g);
  const lb = srgbDecode(b);
  const m = M_SRGB_TO_PROPHOTO;
  out[0] = prophotoEncode(m[0][0] * lr + m[0][1] * lg + m[0][2] * lb);
  out[1] = prophotoEncode(m[1][0] * lr + m[1][1] * lg + m[1][2] * lb);
  out[2] = prophotoEncode(m[2][0] * lr + m[2][1] * lg + m[2][2] * lb);
}

module.exports = {
  displayConverter,
  workingSpaceCheck,
  passthrough,
  srgbToProPhoto,
  proPhotoToSrgb: CONVERTERS.prophoto,
  // 개별 전달함수. .cube를 다른 인코딩으로 옮길 때 쓴다(cubeexport).
  // 원색이 같고 톤 응답만 다른 공간 사이는 이 한 쌍이면 충분하다.
  prophotoDecode,
  prophotoEncode,
  srgbDecode,
  srgbEncode,
  M_PROPHOTO_TO_SRGB,
  M_ADOBE_TO_SRGB,
  M_SRGB_TO_PROPHOTO,
};

