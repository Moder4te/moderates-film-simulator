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

