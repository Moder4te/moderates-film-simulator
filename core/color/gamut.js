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

module.exports = {
  CHROMATIC,
  ACHROMATIC,
  ALL_RANGES,
  CHROMA_BANDS,
  CHROMA_MIN_SAT,
  WHITE_MIN_V,
  BLACK_MAX_V,
  rgbToHsv,
  hsvToRgb,
  hslToRgb,
  classify,
  isChromatic,
  polarOffset,
};
