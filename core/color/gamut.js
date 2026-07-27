/**
 * 색역 판정과 좌표 변환 — 순수 함수만.
 *
 * 여기 있는 것들은 컬러휠(UI), 사진 분석, 그레이딩이 **모두 같은 기준을 쓰도록**
 * 모아 둔 것이다. 색역 경계가 두 곳에 있으면 "휠에서 빨강으로 보이는데 조절은
 * 노랑에 걸리는" 식으로 어긋난다.
 *
 * 이전에는 이 함수들이 `colorwheel.js`(DOM 모듈) 안에 있었고, 사진 분석이 그것을
 * require했다. **계산이 UI에 의존하는 역전**이라 노드에서 시험할 수 없었고, 그래서
 * 16bit·색공간 버그가 실기에서만 드러났다.
 *
 * 모든 입출력은 **sRGB 0~255**를 전제한다. 문서 픽셀을 넣기 전에 심도 정규화와
 * 색공간 변환을 마쳐야 한다(UXP-NOTES 3.1.5).
 */

/** Selective Color 색역 이름. 순서가 UI 배치 순서다. */
const CHROMATIC = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];
const ACHROMATIC = ["whites", "neutrals", "blacks"];
const ALL_RANGES = CHROMATIC.concat(ACHROMATIC);

/** 유채 색역의 중심 색상각. 60° 간격. */
const CHROMA_BANDS = [
  ["reds", 0],
  ["yellows", 60],
  ["greens", 120],
  ["cyans", 180],
  ["blues", 240],
  ["magentas", 300],
];

/**
 * 유채/무채를 가르는 채도 임계와, 무채 안에서 밝기로 가르는 두 경계.
 *
 * **상수로 빼 둔 이유** — 피부톤처럼 새 색역을 넣을 때(TODO 0-7) 여기가 출발점이다.
 * 코드 안에 흩어져 있으면 어디를 고쳐야 할지 알 수 없다.
 */
const CHROMA_MIN_SAT = 0.22;
const WHITE_MIN_V = 0.7;
const BLACK_MAX_V = 0.35;

/**
 * 피부톤 대역 상수. 근거와 사용법은 아래 `skinWeight` 참조.
 * 실측(팔레트 스킨 3단계 + 사진 분석 대표색)에서 뽑았다.
 */
const SKIN = {
  hue: 19.5, // 중심 색상각. 실측 15~24°의 **양 끝을 균등하게** 잡는 자리
  huePlateau: 0.42, // 반폭 중 이 비율까지는 온전히 1.0 (아래 참조)
  hueHalfBase: 12, // range 0에서의 반폭
  hueHalfSpan: 12, // range 100에서 24°까지 넓어진다
  satPeak: 0.5, // 여기까지는 온전히 피부로 본다(어두운 피부가 0.48)
  satMaxBase: 0.55, // range 0에서의 채도 상한
  satMaxSpan: 0.4, // range 100에서 0.95까지
  lumMin: 0.1, // 이보다 어두우면 그림자로 본다
  lumMax: 0.95, // 이보다 밝으면 반사광으로 본다
};

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

/**
 * 아래 세 함수는 `colorwheel.js`에서 **그대로** 옮긴 것이다.
 *
 * 옮기면서 다시 쓰지 않았다 — 반환 형태(배열/객체), 반올림 여부, 각도 기준이
 * 조금만 달라도 마커 위치와 드래그 델타가 어긋난다. 실제로 처음에 `polarOffset`을
 * 객체 반환 + 90° 회전으로 새로 쓸 뻔했다.
 */

/** 색조·채도 → 중심 기준 [dx, dy] px 오프셋. */
function polarOffset(h, s, radius) {
  const rad = (h * Math.PI) / 180;
  return [Math.cos(rad) * s * radius, -Math.sin(rad) * s * radius];
}

/** 반올림하지 않는다 — 드래그 델타 계산이 소수를 그대로 쓴다. */
function hsvToRgb(h, s, v) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function hslToRgb(h, s, l) {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * 색 하나를 색역으로 분류한다.
 *
 * ⚠️ **`v`는 0~1이다.** 0~255 값을 그대로 넣으면 전부 whites로 분류된다 —
 * 실제로 그 버그가 났다(16bit 문서에서 v가 100을 넘었다). `rgbToHsv`의 출력을
 * 그대로 넘기면 된다.
 */
function classify(h, s, v) {
  if (s < CHROMA_MIN_SAT) {
    if (v > WHITE_MIN_V) return "whites";
    if (v < BLACK_MAX_V) return "blacks";
    return "neutrals";
  }
  let best = CHROMA_BANDS[0][0];
  let bd = 999;
  for (const [name, bh] of CHROMA_BANDS) {
    let d = Math.abs(h - bh);
    if (d > 180) d = 360 - d;
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

function isChromatic(range) {
  return CHROMATIC.indexOf(range) >= 0;
}

/**
 * 피부톤 의사 색역 — 고정 6색역과 달리 **색상각 + 채도 창**으로 정의한다.
 *
 * ── 왜 채도가 판별자인가 ────────────────────────────────────────────────
 *
 * 피부는 reds와 yellows에 걸쳐 있어 한쪽만 만지면 부자연스럽고 양쪽을 만지면 피부가
 * 아닌 것까지 딸려 온다. 그런데 **색상각만으로는 가를 수 없다** — 나무 바닥(27°)과
 * 낙엽(30°)이 피부 대역 안에 있다.
 *
 * 실측하면 갈리는 축은 채도다.
 *
 *   피부 (밝은/중간/어두운)   hue 15~23°   채도 **0.26~0.48**   밝기 0.45~0.82
 *   나무·벽돌·낙엽·표지판      hue 11~30°   채도 **0.56~1.00**
 *
 * 그래서 채도 창(satPeak까지 온전히, satMax에서 0)으로 거른다.
 *
 * ⚠️ **어두운 피부가 채도 0.48로 가장 높다.** 채도 상한을 낮게 잡으면 어두운 피부를
 * 놓친다 — 밝은 피부에 맞춰 좁히면 그대로 편향이 된다. 그래서 상한을 넉넉히 두고,
 * 부족하면 `range`로 넓히게 했다. 밝기 범위도 넓게 잡는다(색상각만 좁게).
 *
 * @param {number} h    색상각 0~360
 * @param {number} sat  채도 0~1
 * @param {number} lum  밝기 0~1
 * @param {number} hue  대역 중심 색상각 (스포이드로 바뀔 수 있다)
 * @param {number} range 대역 폭 0~100. 넓히면 어두운 피부·황변색까지, 좁히면 중간톤만
 * @returns {number} 0~1 가중치
 */
function skinWeight(h, sat, lum, hue, range) {
  const r = range == null ? 50 : range < 0 ? 0 : range > 100 ? 100 : range;
  const center = hue == null ? SKIN.hue : hue;

  // 폭과 채도 상한이 같은 슬라이더로 함께 움직인다. 실측상 대역을 넓히려면 두
  // 축을 같이 열어야 한다 — 색상각만 넓히면 채도 높은 목재가 먼저 들어온다.
  const hueHalf = SKIN.hueHalfBase + (r / 100) * SKIN.hueHalfSpan;
  const satMax = SKIN.satMaxBase + (r / 100) * SKIN.satMaxSpan;

  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  if (d >= hueHalf) return 0;
  // **평탄부를 둔다.** 선형으로 깎으면 중심에서 조금만 벗어나도 가중치가 떨어지는데,
  // 실측 피부가 15~24°에 퍼져 있어 어두운 피부(15°)만 불리해진다 — 좁게 잡을수록
  // 밝은 피부에 유리한 편향이 된다. 대역 안쪽은 온전히 1.0으로 두고 가장자리만 깎는다.
  const plateau = hueHalf * SKIN.huePlateau;
  const hueW = d <= plateau ? 1 : 1 - (d - plateau) / (hueHalf - plateau);

  let satW;
  if (sat <= SKIN.satPeak) satW = 1;
  else if (sat >= satMax) return 0;
  else satW = (satMax - sat) / (satMax - SKIN.satPeak);

  // 밝기는 양 끝만 부드럽게 뺀다. 완전 암부·명부는 피부가 아니라 그림자·반사다.
  let lumW = 1;
  if (lum < SKIN.lumMin) lumW = lum / SKIN.lumMin;
  else if (lum > SKIN.lumMax) lumW = (1 - lum) / (1 - SKIN.lumMax);
  if (lumW <= 0) return 0;

  return hueW * satW * lumW;
}

module.exports = {
  CHROMATIC,
  ACHROMATIC,
  ALL_RANGES,
  CHROMA_BANDS,
  CHROMA_MIN_SAT,
  WHITE_MIN_V,
  BLACK_MAX_V,
  SKIN,
  skinWeight,
  rgbToHsv,
  hsvToRgb,
  hslToRgb,
  classify,
  isChromatic,
  polarOffset,
};
