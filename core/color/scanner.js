/**
 * 스캐너 스테이지 — 원본 명세 02번.
 *
 * 유제 단계(film.js)는 TDS 수치를 그대로 재현한다. 그런데 실기 측정에서 드러난
 * 대로, 그것만으로는 "필름 룩"이 되지 않는다.
 *
 *   · 암부가 뜬다      원본 p5 9.3 → 필름 21~27 (필름의 발끝/베이스 포그)
 *   · 채도가 떨어진다   Δ채도 −0.10 ~ 0.00
 *   · 필름 간 차이가 작다  평균 R 폭 6.2 / G 폭 4.7
 *
 * 셋 다 원인이 하나다 — **스캐너·인화 단계가 없다.** 실제 필름의 대비와 채도는
 * 상당 부분 그 단계에서 나오고, 블랙포인트도 스캐너가 잡는다. TDS에는 그 정보가
 * 전혀 없다(v2plan 4.2).
 *
 * 그래서 이 단계는 **측정이 아니라 튜닝**이다. C4대로 공개 데이터를 못 찾으면
 * 눈으로 맞추는 것이 처음부터의 계획이었고, 그래서 파라미터를 사람이 읽고
 * 고칠 수 있는 형태로 노출한다.
 *
 * 적용 공간: 유제 단계가 인코딩까지 마친 값(0~1) 위에서 동작한다. 스캐너의
 * 렌더링은 지각 공간에서 다루는 것이 직관적이고 조율하기 쉽다.
 */

/**
 * S커브. a=1이면 항등, 클수록 중간톤이 가팔라진다.
 * 양 끝(0,1)이 고정되고 단조라 계조가 뒤집히지 않는다.
 */
function scurve(v, a) {
  if (a === 1) return v;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const p = Math.pow(v, a);
  return p / (p + Math.pow(1 - v, a));
}

/**
 * 기준 그레이(18%)의 인코딩 값. S커브 피벗.
 *
 * scurve는 0.5를 고정점으로 갖는다. 그런데 필름을 통과한 사진의 중간톤은
 * 0.386(=0.18^(1/1.8)) 부근이라 피벗보다 **아래**에 있다. 그대로 쓰면 대비를
 * 올릴수록 중간톤이 눌려 사진이 어두워진다 — 실측에서 중앙값이 88.5 → 37.8로
 * 반토막 났다. 피벗을 기준 그레이로 옮겨야 대비가 중간톤을 중심으로 벌어진다.
 */
const PIVOT = Math.pow(0.18, 1 / 1.8);
const PIVOT_IN = Math.log(0.5) / Math.log(PIVOT);
const PIVOT_OUT = 1 / PIVOT_IN;

/** 기준 그레이를 고정점으로 하는 S커브. */
function scurveAtPivot(v, a) {
  if (a === 1 || v <= 0) return v <= 0 ? 0 : v;
  if (v >= 1) return 1;
  return Math.pow(scurve(Math.pow(v, PIVOT_IN), a), PIVOT_OUT);
}

/**
 * 톤 가중치. 틴트 혼합 비율과 채도 연산의 기준점을 정한다.
 *
 * ⚠️ **이것은 광도(luminance)가 아니다.** 두 가지 이유로 그렇다.
 *
 * 1. 값이 Rec.709 계수인데 이 단계의 데이터는 **ProPhoto 원색**이다.
 *    ProPhoto의 Y행은 `[0.2880, 0.7119, 0.0001]`이다(colorspace.js의
 *    `PROPHOTO_TO_XYZ_D50` 참조). 청색 가중치가 특히 크게 다르다.
 * 2. 더 근본적으로, 광도 계수는 **선형광**에 대해 정의된 것인데 여기서는
 *    **인코딩된 값(γ1.8)** 에 곱한다. 어느 계수를 쓰든 광도가 되지 않는다.
 *
 * 즉 계수만 ProPhoto 값으로 바꾼다고 "올바른 광도"가 되지는 않는다. 선택지는
 * 어느 근사를 쓰느냐이고, 인코딩 공간에서 다루는 것은 조율하기 쉬워 그레이딩
 * 도구에서 흔히 하는 선택이다(이 파일 헤더 참조).
 *
 * **그대로 두는 이유** — 이 파일의 스캐너 파라미터는 이 수식 그대로 눈으로
 * 튜닝한 값이다. 계수를 바꾸면 룩이 바뀌므로 재튜닝과 묶어야 한다. 실측상
 * ProPhoto 계수로 바꿨을 때의 차이는 Ektar 100 기준 **최대 0.0155(≈4/255),
 * 평균 0.0016** 이다. 지금 단독으로 고칠 이유가 되지 못한다.
 *
 * 실측 스캐너 데이터를 확보해 재튜닝할 때(TODO A1) 함께 정리한다.
 */
const LUM = [0.2126, 0.7152, 0.0722];

/**
 * 색상을 지키며 [0,1]에 맞춘다.
 *
 * 채널마다 따로 자르면 **RGB 비율이 깨져 색상 자체가 틀어진다.** 채도를 올린 뒤
 * 한 채널만 1을 넘어 잘리면 그 색은 밝기만 바뀌는 게 아니라 다른 색이 된다.
 *
 * 대신 기준점(`t`) 쪽으로 세 채널을 **함께** 당겨 범위 안에 넣는다. 비율이
 * 유지되므로 색상이 보존되고, 대신 채도가 준다 — 표현할 수 없는 채도를 포기하는
 * 것이 색을 바꾸는 것보다 낫다.
 *
 * 실측 (frontier + Ektar 100, 33³ 중 클램프되는 7,284점):
 *
 *   하드 클리핑      색상 최대 1.7°, 870점이 1° 초과
 *   이 방식          색상 최대 0.0°, 평균 채도손실은 0.0004만 더 든다
 *
 * 현재 채도가 1.03~1.04로 약해 하드 클리핑의 피해도 작다(1.7°는 변별 임계 아래).
 * 그래도 고쳐 두는 이유는 **채도를 올리는 순간 바로 커지기 때문**이다. 스캐너
 * 프로파일을 추가하거나 채도를 사용자에게 노출하면 그때 드러난다.
 */
function fitGamut(r, g, b, out) {
  const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
  const lo = r < g ? (r < b ? r : b) : g < b ? g : b;

  if (hi <= 1 && lo >= 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  // 당길 기준점. 이것도 범위 안에 있어야 맞춰 넣을 수 있다.
  const t = LUM[0] * r + LUM[1] * g + LUM[2] * b;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;

  let s = 1;
  if (hi > 1 && hi > c) s = Math.min(s, (1 - c) / (hi - c));
  if (lo < 0 && lo < c) s = Math.min(s, c / (c - lo));

  // 부동소수 오차로 아주 미세하게 넘칠 수 있어 마지막에 한 번 더 조인다.
  const fr = c + (r - c) * s;
  const fg = c + (g - c) * s;
  const fb = c + (b - c) * s;
  out[0] = fr < 0 ? 0 : fr > 1 ? 1 : fr;
  out[1] = fg < 0 ? 0 : fg > 1 ? 1 : fg;
  out[2] = fb < 0 ? 0 : fb > 1 ? 1 : fb;
  return out;
}

// 중간톤 틴트의 영향 폭과 최대 비중. 피벗에서 최대, PIVOT_WIDTH 밖에선 0.
const PIVOT_WIDTH = 0.24;
const MID_MAX = 0.6;

const SCANNERS = [
  {
    id: "none",
    displayName: "없음",
    note: "유제 반응만. 스캐너 특성을 빼고 TDS 그대로 본다.",
    blackPoint: 0,
    whitePoint: 1,
    contrast: 0,
    saturation: 1,
    shadowTint: { r: 1, g: 1, b: 1 },
    highlightTint: { r: 1, g: 1, b: 1 },
  },
  {
    id: "frontier",
    displayName: "Fuji Frontier",
    note:
      "시안 섀도 + 골든 스킨, 높은 콘트라스트, 채도 강조. 쨍한 인상. " +
      "⚠️ 실측이 아니라 현상소 비교 문헌의 정성 서술을 수치로 옮긴 값이다.",
    // 문헌 근거 — Frontier는 대비 곡선이 강해 암부가 깊고 명부가 압축되며,
    // 황–청 축을 강조해 **시안 섀도 + 골든 스킨**이 된다.
    blackPoint: 0.058,
    whitePoint: 0.995, // 명부 압축
    contrast: 0.12,
    saturation: 1.04,
    shadowTint: { r: 0.958, g: 1.0, b: 1.058 }, // 시안으로
    midTint: { r: 1.042, g: 1.006, b: 0.945 }, // 골든 스킨 — 중간톤만
    highlightTint: { r: 1.0, g: 1.0, b: 1.0 }, // 명부는 중성
  },
  {
    id: "noritsu",
    displayName: "Noritsu Koki",
    note:
      "중성 섀도, 낮은 콘트라스트, 명부 유지 좋음, 색이 더 뮤트하고 스킨이 핑크쪽. " +
      "⚠️ 실측이 아니라 현상소 비교 문헌의 정성 서술을 수치로 옮긴 값이다.",
    // 문헌 근거 — Noritsu는 대비가 낮고 "light and airy", 명부 보존이 좋으며
    // 마젠타–녹 균형을 강조해 **중성 섀도 + 핑크 스킨**, 전반적으로 더 뮤트하다.
    //
    // ⚠️ 처음엔 암부를 웜으로 잡았는데 문헌과 어긋난다. 웜 섀도는 Frontier의
    // 반대말로 흔히 쓰이지만, 실제 서술은 "중성"이지 "따뜻함"이 아니다.
    blackPoint: 0.042, // Frontier보다 덜 내림
    whitePoint: 1.0, // 명부 압축 안 함
    contrast: 0.08,
    saturation: 1.03, // 더 뮤트
    shadowTint: { r: 1.0, g: 1.0, b: 1.0 }, // 중성
    midTint: { r: 1.03, g: 0.99, b: 1.012 }, // 핑크 쪽 (마젠타)
    highlightTint: { r: 1.0, g: 1.0, b: 1.0 },
  },
];

const BY_ID = new Map(SCANNERS.map((s) => [s.id, s]));

function all() {
  return SCANNERS;
}

function byId(id) {
  return BY_ID.get(id) || BY_ID.get("none");
}

/** 중립(아무것도 하지 않는) 스캐너인가. 중립이면 LUT을 건드리지 않는다. */
function isNeutral(s) {
  return (
    s.blackPoint === 0 && s.whitePoint === 1 && s.contrast === 0 && s.saturation === 1 &&
    s.shadowTint.r === 1 && s.shadowTint.g === 1 && s.shadowTint.b === 1 &&
    s.highlightTint.r === 1 && s.highlightTint.g === 1 && s.highlightTint.b === 1 &&
    (!s.midTint || (s.midTint.r === 1 && s.midTint.g === 1 && s.midTint.b === 1))
  );
}

/**
 * 완성된 필름 LUT에 스캐너 특성을 구워 넣는다. table을 제자리에서 고친다.
 *
 * 순서가 결과를 좌우한다.
 *   1. 레벨    — 블랙포인트를 잡는다. 유제만으로는 뜬 암부를 여기서 내린다.
 *   2. 틴트    — 밝기로 암부/명부 색조를 섞는다. 스캐너 개성의 핵심.
 *   3. S커브   — 대비. 레벨 뒤에 와야 검정이 제자리에서 눌린다.
 *   4. 채도    — 마지막. 앞 단계가 만든 색을 증폭한다.
 */
function bake(table, scanner) {
  if (isNeutral(scanner)) return table;

  const { blackPoint: bp, whitePoint: wp, contrast, saturation: sat } = scanner;
  const span = wp - bp;
  const a = 1 + contrast * 2;
  const st = scanner.shadowTint;
  const ht = scanner.highlightTint;
  const mt = scanner.midTint || null;
  const fitted = [0, 0, 0]; // fitGamut 출력 버퍼. 격자점마다 새로 만들지 않는다.

  // 레벨의 피벗 복원 감마.
  //
  // (v−b)/(1−b)는 상수 뺄셈이라 암부만이 아니라 **중간톤도 같이 내린다**.
  // 실측에서 중앙값이 88.5 → 63으로 떨어진 주범이었다. 레벨 뒤에 감마를 걸어
  // 기준 그레이를 제자리로 되돌리면, 검정은 내려가고 중간톤은 유지된다.
  let levelGamma = 1;
  if (span > 0 && bp > 0) {
    const moved = (PIVOT - bp) / span;
    if (moved > 0 && moved < 1) levelGamma = Math.log(PIVOT) / Math.log(moved);
  }

  for (let p = 0; p < table.length; p += 3) {
    let r = table[p], g = table[p + 1], b = table[p + 2];

    // 1. 레벨
    if (span > 0) {
      r = (r - bp) / span;
      g = (g - bp) / span;
      b = (b - bp) / span;
    }
    // 여기는 **의도적으로 채널별 하드 클램프**다. 블랙포인트는 원래 채널마다
    // 자르는 조작이고(스캐너·Levels가 그렇게 동작한다), 그 아래를 검정으로
    // 뭉개는 것이 목적이다. 색상을 지키려고 소프트 클립을 걸면 블랙포인트가
    // 블랙포인트가 아니게 된다. 아래 pow가 음수에서 NaN이 되는 것도 막는다.
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    g = g < 0 ? 0 : g > 1 ? 1 : g;
    b = b < 0 ? 0 : b > 1 ? 1 : b;

    if (levelGamma !== 1) {
      r = Math.pow(r, levelGamma);
      g = Math.pow(g, levelGamma);
      b = Math.pow(b, levelGamma);
    }

    // 2. 틴트 — 밝기로 암부/중간톤/명부 이득을 섞는다.
    //
    // 암부↔명부 2점 보간만으로는 **중간톤만 물들이는 것**을 표현할 수 없다.
    // Frontier의 "골든 스킨"이 정확히 그런 특성이라(차가운 암부 + 따뜻한 중간톤
    // + 중성 명부) 중간톤 항을 따로 둔다. 가중치는 피벗에서 최대인 삼각형이고,
    // 세 가중치의 합이 1이라 중립 설정이면 아무것도 하지 않는다.
    const t = LUM[0] * r + LUM[1] * g + LUM[2] * b;
    const wm = mt ? Math.max(0, 1 - Math.abs(t - PIVOT) / PIVOT_WIDTH) * MID_MAX : 0;
    const rest = 1 - wm;
    const ws = (1 - t) * rest;
    const wh = t * rest;
    r *= st.r * ws + (mt ? mt.r : 1) * wm + ht.r * wh;
    g *= st.g * ws + (mt ? mt.g : 1) * wm + ht.g * wh;
    b *= st.b * ws + (mt ? mt.b : 1) * wm + ht.b * wh;

    // 3. S커브
    if (a !== 1) {
      r = scurveAtPivot(r, a);
      g = scurveAtPivot(g, a);
      b = scurveAtPivot(b, a);
    }

    // 4. 채도
    if (sat !== 1) {
      const l = LUM[0] * r + LUM[1] * g + LUM[2] * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }

    // 5. 색역 정합 — 채널마다 따로 자르면 색상이 틀어진다(fitGamut 참조).
    fitGamut(r, g, b, fitted);
    table[p] = fitted[0];
    table[p + 1] = fitted[1];
    table[p + 2] = fitted[2];
  }
  return table;
}

module.exports = { all, byId, bake, isNeutral, scurve, scurveAtPivot, fitGamut, PIVOT, LUM };





