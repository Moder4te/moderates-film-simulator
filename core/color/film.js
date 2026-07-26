/**
 * 센시토메트리 엔진 — 필름 특성곡선을 3D LUT으로 굽는다.
 *
 * 모델 (격자점 하나당):
 *
 *   1. 디코드      L = v^γ                       ProPhoto γ1.8 → 선형
 *   2. 로그 노광   H = log10(L / 0.18) + 스톱     18% 그레이를 H=0에 앵커
 *   3. 특성곡선    D = curve(H)                   층별 네거티브 농도
 *   4. 반전/인화   P = 0.18 · 10^(pg · (D − D₀))  D₀ = curve(0)
 *   5. 크로스토크  P' = M · P                     선형 공간에서 3×3
 *   6. 인코드      v' = P'^(1/γ)
 *
 * **4단계가 이 모델의 핵심이다.** 각 층의 농도를 그 층이 기준 노광에서 갖는 농도
 * D₀로 정규화한 뒤 인화 감마 pg로 되돌린다. 이렇게 두면 두 가지가 자동으로 성립한다.
 *
 *   - 오렌지 마스크처럼 층마다 다른 **절대 농도 오프셋이 상쇄된다.** 마스크 때문에
 *     화면 전체가 주황색으로 물드는 일이 없다. 실제 스캐너도 같은 일을 한다.
 *   - H=0에서 세 채널 모두 P=0.18이 되어 **기준 그레이가 중성으로 유지된다.**
 *
 * 그래서 색을 만드는 것은 농도의 절대값이 아니라 **곡선 기울기의 층별 차이**다.
 * 적감층 기울기가 높으면 하이라이트가 따뜻해지고 암부가 차가워진다. 필름마다
 * 다른 "색감"의 정체가 이것이고, TDS 수치를 그대로 쓰는 의미도 여기에 있다.
 *
 * pg·γ = 1이면 그 채널은 항등(입력=출력)이 된다. 즉 printGamma는 전체 대비를
 * 정하는 손잡이이고, 채널별 편차가 색을 만든다.
 */

const { pchip, tabulate, monotonic } = require("./curve");
const films = require("./films");
const simulate = require("./simulate");
const colorspace = require("./colorspace");
const scanner = require("./scanner");
const lut = require("./lut");

const WORKING_GAMMA = 1.8; // ProPhoto RGB
const ANCHOR = 0.18; // 18% 그레이
const LOG2 = Math.log10(2);

/**
 * 중간 그레이 앵커 보정 (로그10 단위). H=0을 TDS의 Log H Ref에서 이만큼 옮긴다.
 *
 * 배경 — Kodak TDS 5종(ISO 100/160/200/400/800)을 대조한 결과
 * `Log H Ref = log10(14.4 / ISO)`가 3스톱 범위에서 편차 0.022스톱으로 성립한다.
 * 즉 Log H Ref는 필름별 임의 앵커가 아니라 **감도로 완전히 결정되는 기준 노광점**이고,
 * 이를 H=0으로 삼는 것은 "모든 필름을 박스 스피드로 정상 노광했다"와 같다.
 * 필름 차이가 감도가 아니라 곡선 형태에서만 나오므로 우리가 원하는 동작이다.
 *
 * 다만 **절대 위치는 어긋난다.** ISO 측광 이론의 18% 그레이 노광은 H = q·K/S
 * (q=0.65, K=12.5) → 8.1/S 이고, Log H Ref는 14.4/S 다. 차이 약 0.25 log
 * (0.8스톱). 검토자 두 명이 K 상수를 달리 잡아 0.54스톱과 0.83스톱으로 다르게
 * 계산한 것에서 보듯 정확한 값 자체가 불확실하다.
 *
 * 그래서 **기본값을 0으로 두고 손잡이만 만들어 둔다.** C3대로 기준이 되는
 * "정답 스캔"이 없으므로 추정값을 박아 넣는 것은 근거 없는 이동일 뿐이다.
 * 나중에 레퍼런스가 생기면 이 상수 하나를 **한 번만** 맞춘다.
 *
 * ⚠️ 필름마다 다른 값을 주면 안 된다. 오프셋은 모든 필름에서 동일한 전역 상수다
 * (위 표의 k가 상수라는 것이 그 근거). 필름별로 넣으면 감도 차이를 이중 적용하게 된다.
 */
const MID_GRAY_OFFSET = 0;

// 커브 조회를 배열 룩업으로 바꿀 때의 정밀도. H는 이 범위 안에서만 쓴다.
const TAB_MIN = -6;
const TAB_MAX = 3;
const TAB_STEPS = 4096;

// L=0이면 H가 -∞가 되므로 바닥을 둔다. 곡선 데이터 범위 바로 바깥이라
// 발끝 기울기로 살짝 외삽되는 정도에 그친다.
const L_FLOOR = 1e-4;

/**
 * 필름 종류.
 *
 *   color-negative — 노광↑ → 농도↑. 인화/스캔이 반전시킨다.
 *   color-reversal — 노광↑ → 농도↓. **슬라이드 자체가 이미 포지티브다.**
 *   bw-negative    — 층이 하나. RGB를 휘도로 합친 뒤 단일 곡선을 태운다.
 *
 * 종류마다 4단계(반전/인화)의 부호와 정규화 방식이 다르다. 아래 참조.
 */
const TYPES = {
  "color-negative": { sign: +1, channels: 3 },
  "color-reversal": { sign: -1, channels: 3 },
  "bw-negative": { sign: +1, channels: 1 },
};

function typeOf(film) {
  const t = TYPES[film.type];
  if (!t) throw new Error(`알 수 없는 필름 종류: ${film.type} (${film.id})`);
  return t;
}

/**
 * 한 층의 응답 함수를 만든다. 입력 0~1(인코딩된 값) → 출력 선형 포지티브.
 *
 * 네거티브: P = 0.18 · 10^(+pg · (D − D₀))
 *   노광이 늘면 농도가 오르고, 인화 감마 pg가 그것을 되돌려 밝기로 바꾼다.
 *   기준 노광에서 P = 0.18이 되도록 D₀로 정규화한다.
 *
 * 리버설: P = 10^(−pg · (D − Dmin))
 *   **부호가 반대다.** 노광이 늘면 농도가 내려가고, 슬라이드는 그 자체가 볼 수 있는
 *   포지티브다 — 눈에 보이는 밝기가 곧 투과율 10^(−D)이다. 그래서 인화 단계가
 *   따로 없고 pg의 기본값이 1.0이다(슬라이드의 가파른 대비가 곧 그 필름의 룩이다).
 *
 *   정규화 기준도 다르다. 네거티브는 기준 그레이(D₀)에 맞추지만, 리버설은
 *   **최소 농도(Dmin)를 흰색 1.0에 맞춘다.** 슬라이드 스캐너가 하는 일이 그것이고,
 *   기준 그레이에 맞추면 대비가 2를 넘는 슬라이드에서 출력이 5를 넘어가 버린다.
 */
function channelResponse(points, printGamma, exposureStops, sign) {
  // 리버설 곡선은 노광이 늘수록 농도가 **내려간다**. 단조 보정은 "증가"를
  // 강제하므로 그대로 쓰면 곡선을 뭉갠다. 부호를 뒤집어 보정한 뒤 되돌린다.
  const src = sign > 0
    ? monotonic(points)
    : monotonic(points.map(([h, d]) => [h, -d])).map(([h, d]) => [h, -d]);

  const fn = tabulate(pchip(src), TAB_MIN, TAB_MAX, TAB_STEPS);
  const shift = exposureStops * LOG2 - MID_GRAY_OFFSET;

  if (sign > 0) {
    // 네거티브 — 기준 그레이에서 P = 0.18이 되도록 맞춘다.
    const d0 = fn(MID_GRAY_OFFSET);
    return function respond(v) {
      const L = Math.pow(v, WORKING_GAMMA);
      const H = Math.log10(Math.max(L, L_FLOOR) / ANCHOR) + shift;
      return ANCHOR * Math.pow(10, printGamma * (fn(H) - d0));
    };
  }

  // 리버설 — **가장 밝은 입력(v=1)이 만드는 농도**를 흰색 1.0에 맞춘다.
  //
  // 처음엔 곡선 전체의 최소 농도(Dmin)를 기준으로 잡았는데, 그러면 입력이 실제로
  // 도달하지 못하는 노광 구간의 농도까지 기준이 되어 결과가 새까맣게 나온다
  // (합성 곡선에서 최대 출력이 0.0099까지 떨어졌다). 스캐너가 하는 일은 "필름이
  // 낼 수 있는 최저 농도"가 아니라 "장면의 가장 밝은 곳"을 흰색에 놓는 것이다.
  //
  // 기준은 **노광 보정 0에서** 잡는다. 현재 노광에서 다시 잡으면 노광 보정이
  // 스스로를 상쇄한다(네거티브 화이트포인트와 같은 함정). 그래서 +노광은 흰색을
  // 넘어 잘리는데, 슬라이드가 실제로 그렇게 날아간다.
  const dWhite = fn(H_WHITE + MID_GRAY_OFFSET);
  return function respond(v) {
    const L = Math.pow(v, WORKING_GAMMA);
    const H = Math.log10(Math.max(L, L_FLOOR) / ANCHOR) + shift;
    return Math.pow(10, -printGamma * (fn(H) - dWhite));
  };
}

// v=1(선형 L=1)에 대응하는 로그 노광. 화이트포인트 기준점.
const H_WHITE = Math.log10(1 / ANCHOR);

/**
 * 노광 보정 0에서 v=1이 만드는 선형 포지티브 값.
 * 화이트포인트 이득을 노광과 무관하게 고정하기 위한 기준.
 */
function referencePeak(points, printGamma) {
  const f = pchip(monotonic(points)); // channelResponse와 같은 곡선을 써야 한다
  return ANCHOR * Math.pow(10, printGamma * (f(H_WHITE + MID_GRAY_OFFSET) - f(MID_GRAY_OFFSET)));
}

/**
 * 필름 정의에서 3D LUT을 굽는다.
 *
 * @param {object} film       films.js의 필름 정의
 * @param {object} [opts]
 * @param {number} [opts.size=33]      격자 크기
 * @param {number} [opts.exposure=0]   노광 보정 (스톱)
 * @returns {Float32Array} size³ × 3, .cube 순서(R 인덱스가 가장 빨리 변함)
 */
function buildLut(film, opts) {
  const o = opts || {};
  const size = o.size || 33;
  const exposure = o.exposure || 0;

  const range = film.exposureRange || [-2, 2];
  if (exposure < range[0] || exposure > range[1]) {
    throw new Error(
      `노광 보정 ${exposure}스톱이 ${film.displayName}의 범위 [${range[0]}, ${range[1]}]를 벗어납니다`
    );
  }

  const info = typeOf(film);
  const pg = film.printGamma;
  const cur = film.characteristicCurves;

  if (info.channels === 1) return buildMonoLut(film, size, exposure, info);

  const respond = [
    channelResponse(cur.r, pg, exposure, info.sign),
    channelResponse(cur.g, pg, exposure, info.sign),
    channelResponse(cur.b, pg, exposure, info.sign),
  ];

  // 1~4단계는 채널끼리 독립이고, 격자의 각 축은 같은 size개 값만 갖는다.
  // 축마다 한 번씩만 계산해 두면 size³ 루프에서는 크로스토크와 인코딩만 남는다.
  const d = size - 1;
  const axis = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
  for (let i = 0; i < size; i++) {
    const v = i / d;
    axis[0][i] = respond[0](v);
    axis[1][i] = respond[1](v);
    axis[2][i] = respond[2](v);
  }

  const m = film.crosstalk || [
    [100, 0, 0],
    [0, 100, 0],
    [0, 0, 100],
  ];

  // --- 스캐너 화이트포인트 정규화 -------------------------------------------
  //
  // 실효대비(기울기 × printGamma)가 1을 넘는 층은 v=1에서 출력이 1.0을 넘는다.
  // 예를 들어 Portra의 청감층은 실효대비 1.085라 0.18 × 5.56^1.085 = 1.16이 된다.
  // 그대로 두면 층마다 다른 지점에서 잘려 **하이라이트의 색이 틀어진다**.
  //
  // 실제 스캐너는 필름의 농도 범위를 출력 범위에 맞춰 노출을 잡는다. 여기서도
  // 같은 일을 한다 — 세 층 공통의 스칼라 이득이므로 **채널 비율(=색상)은 그대로**이고
  // 전체 밝기만 내려간다. 대비가 센 필름에서 중간톤이 조금 어두워지는 것은
  // 실제 스캔에서도 나타나는 정상적인 거동이다.
  //
  // 크로스토크 행의 합이 1.0을 넘을 수 있으므로 그 배수까지 함께 고려한다
  // (출력_i ≤ 행합_i × max(P)).
  //
  // ⚠️ 이득은 **노광 보정 0을 기준으로** 계산한다. 현재 노광에서 다시 계산하면
  // 노광을 올릴수록 하이라이트가 밝아져 이득이 더 세게 걸리고, 결과적으로
  // 노광 보정이 스스로를 상쇄한다(실제로 +1스톱이 0스톱보다 어두워졌다).
  // 스캐너도 화이트포인트를 필름 기준으로 한 번 정하지 매 컷 다시 잡지 않는다.
  //
  // 리버설은 이 단계를 건너뛴다. Dmin을 흰색에 맞추는 정규화가 채널 응답 안에서
  // 이미 끝나 있고, 여기서 또 누르면 슬라이드 특유의 대비가 뭉개진다.
  //
  // 기본은 **채널별 소프트 롤오프**(rolloff)다. 상한 근처만 부드럽게 눌러
  // 1.0으로 수렴시키고, 무릎(knee) 아래는 손대지 않는다.
  //
  // 여기까지 두 번 틀렸다.
  //
  // 1차 — 세 층 공통 스칼라 이득. 이득이 가장 가파른 층(청감)에 맞춰지니 대비가
  //   낮은 적감층이 더 눌려서 (a) 전체가 어두워지고 (b) 하이라이트가 청색으로
  //   기울었다. 실측: 원본 대비 평균 R이 최대 −28, R−B가 +19.6 → −1.1로 20포인트
  //   이동. 채도 높기로 이름난 Agfa Ultra 50이 피부를 시안으로 만들었다.
  //
  // 2차 — 채널별 이득. 흰색은 완벽히 중성이 됐지만(편차 0) **중간톤이 대신
  //   틀어졌다**(Ultra 50 편차 0.091 = 8비트 23계단). 중성점이 중간톤에서
  //   흰색으로 옮겨간 것뿐, 문제가 사라진 게 아니다. 채널 실효대비가 다르면
  //   무채색 축이 전 구간 중성일 수 없다 — 어디를 고정할지의 문제다.
  //
  // 진짜 원인은 **TDS 곡선에 어깨(shoulder)가 없다**는 것이다. 대부분의 플롯이
  // 직선부에서 잘려 있어(판독 기록 참조) 상한 부근을 압축할 근거가 데이터에 없다.
  // 전역 이득은 그 빠진 어깨를 흉내내는 조잡한 대용품이었다. 롤오프는 어깨를
  // 명시적으로 만들어 준다 — 무릎 아래(중간톤 포함)는 건드리지 않으므로 기준
  // 그레이 중성이 유지되고, 상한 근처에서만 채널이 함께 수렴해 하이라이트
  // 캐스트도 줄어든다.
  //
  // `whitePoint`로 "scalar" / "perChannel" / "clip"을 고를 수 있다.
  const wp = film.whitePoint || "rolloff";
  if (wp !== "clip" && info.sign > 0) {
    const rowSum = [
      (m[0][0] + m[0][1] + m[0][2]) / 100,
      (m[1][0] + m[1][1] + m[1][2]) / 100,
      (m[2][0] + m[2][1] + m[2][2]) / 100,
    ];
    const peaks = ["r", "g", "b"].map((ch, i) => referencePeak(cur[ch], pg) * Math.max(rowSum[i], 1));

    if (wp === "scalar") {
      const peak = Math.max(...peaks);
      if (peak > 1) {
        const gain = 1 / peak;
        for (let c = 0; c < 3; c++) for (let i = 0; i < size; i++) axis[c][i] *= gain;
      }
    } else if (wp === "perChannel") {
      for (let c = 0; c < 3; c++) {
        if (peaks[c] > 0) {
          const gain = 1 / peaks[c];
          for (let i = 0; i < size; i++) axis[c][i] *= gain;
        }
      }
    } else {
      // 무릎은 기준 그레이(0.18)보다 충분히 위에 둔다 — 중간톤을 건드리지 않기 위해.
      const knee = film.rolloffKnee || 0.5;
      const span = 1 - knee;
      const soft = (p) => (p <= knee ? p : knee + span * (1 - Math.exp(-(p - knee) / span)));

      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < size; i++) axis[c][i] = soft(axis[c][i]);
      }

      // 롤오프 뒤에 이득을 붙여 상한을 1.0에 맞추는 것도 해봤는데 채택하지 않았다.
      // 흰색은 순백이 되지만 **필름마다 기준 그레이 밝기가 달라진다**(+0.08~+0.24스톱).
      // 필름 비교가 목적이므로 밝기 일관성이 순백보다 중요하다. 이득 없이 두면
      // 기준 그레이가 전 필름 0.00스톱으로 일치하고, 대신 흰색이 0.88~0.94에
      // 머문다 — 인화지도 하이라이트에서 종이 흰색에 닿지 않으므로 부자연스럽지 않다.
    }
  }
  const m00 = m[0][0] / 100, m01 = m[0][1] / 100, m02 = m[0][2] / 100;
  const m10 = m[1][0] / 100, m11 = m[1][1] / 100, m12 = m[1][2] / 100;
  const m20 = m[2][0] / 100, m21 = m[2][1] / 100, m22 = m[2][2] / 100;
  const identity =
    m00 === 1 && m11 === 1 && m22 === 1 &&
    m01 === 0 && m02 === 0 && m10 === 0 && m12 === 0 && m20 === 0 && m21 === 0;

  const invGamma = 1 / WORKING_GAMMA;
  const lut = new Float32Array(size * size * size * 3);
  let p = 0;

  for (let bi = 0; bi < size; bi++) {
    const pb = axis[2][bi];
    for (let gi = 0; gi < size; gi++) {
      const pgv = axis[1][gi];
      for (let ri = 0; ri < size; ri++) {
        const pr = axis[0][ri];

        let R = pr;
        let G = pgv;
        let B = pb;
        if (!identity) {
          R = m00 * pr + m01 * pgv + m02 * pb;
          G = m10 * pr + m11 * pgv + m12 * pb;
          B = m20 * pr + m21 * pgv + m22 * pb;
        }

        lut[p++] = R <= 0 ? 0 : R >= 1 ? 1 : Math.pow(R, invGamma);
        lut[p++] = G <= 0 ? 0 : G >= 1 ? 1 : Math.pow(G, invGamma);
        lut[p++] = B <= 0 ? 0 : B >= 1 ? 1 : Math.pow(B, invGamma);
      }
    }
  }

  return lut;
}

/**
 * 흑백 필름 LUT.
 *
 * 유제층이 하나뿐이라 컬러와 구조가 다르다.
 *   - 먼저 RGB를 **하나의 노광량**으로 합친 뒤 단일 곡선을 태운다.
 *   - 크로스토크와 층별 감마는 의미가 없다(층이 하나다).
 *   - 출력은 무채색이다.
 *
 * 그래서 컬러 경로의 "축마다 한 번씩만 계산" 최적화를 쓸 수 없다. 채널을 섞은
 * 뒤에 곡선을 타므로 격자점마다 계산해야 한다. 곡선이 배열 조회라 size³
 * 그대로 돌려도 충분히 빠르다.
 *
 * `spectralWeights`는 그 필름이 R/G/B 빛에 얼마나 반응하는가다. TDS의 분광
 * 감도 곡선에서 유도하는 것이 정석이고, 없으면 범색성(panchromatic) 근사값을
 * 쓴다. 이 가중치가 흑백 필름의 성격을 만든다 — 적색 비중이 크면 하늘이
 * 어두워지고 피부가 밝아진다. 필터 시뮬레이션도 결국 이 가중치를 바꾸는 일이다.
 */
const PANCHROMATIC = { r: 0.30, g: 0.59, b: 0.11 };

function buildMonoLut(film, size, exposure, info) {
  const pg = film.printGamma;
  const cur = film.characteristicCurves;
  const pts = cur.mono || cur.g;
  if (!pts) throw new Error(`${film.id}: 흑백 필름인데 mono 곡선이 없습니다`);

  const w = film.spectralWeights || PANCHROMATIC;
  const sum = w.r + w.g + w.b;
  const wr = w.r / sum, wg = w.g / sum, wb = w.b / sum;

  const respond = channelResponse(pts, pg, exposure, info.sign);

  // 화이트포인트 정규화 — 컬러와 같은 이유로 필요하다. 단일 채널이라
  // 색이 틀어질 일은 없고, 상한을 넘는 것만 막는다.
  let gain = 1;
  if (film.whitePoint !== "clip") {
    const peak = respond(1);
    if (peak > 1) gain = 1 / peak;
  }

  const d = size - 1;
  const invGamma = 1 / WORKING_GAMMA;
  const lut = new Float32Array(size * size * size * 3);
  let p = 0;

  // 축별 선형값을 미리 계산해 pow 호출을 size³에서 size로 줄인다.
  const lin = new Float64Array(size);
  for (let i = 0; i < size; i++) lin[i] = Math.pow(i / d, WORKING_GAMMA);

  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        // 선형 공간에서 섞는다. 인코딩된 값을 섞으면 밝기가 틀어진다.
        const L = wr * lin[ri] + wg * lin[gi] + wb * lin[bi];
        let P = respond(Math.pow(L, invGamma)) * gain;
        P = P <= 0 ? 0 : P >= 1 ? 1 : Math.pow(P, invGamma);
        lut[p++] = P;
        lut[p++] = P;
        lut[p++] = P;
      }
    }
  }
  return lut;
}

/**
 * grading이 실제로 색을 바꾸는 상태인지 본다.
 * 중립이면 sRGB 왕복(=색역 클리핑)을 통째로 건너뛰기 위한 판정이다.
 */
function gradingIsActive(g) {
  if (!g || !g.enabled) return false;
  if (g.toe !== 0 || g.shoulder !== 0) return true;
  const gain = g.channelGain || {};
  if (gain.r !== 1 || gain.g !== 1 || gain.b !== 1) return true;
  if (g.crosstalk && g.crosstalk.enabled && g.crosstalk.amount !== 0) return true;
  const sc = g.selectiveColor || {};
  for (const k of Object.keys(sc)) {
    const v = sc[k];
    if (v && (v.c || v.m || v.y || v.k)) return true;
  }
  return false;
}

/**
 * 완성된 필름 LUT 위에 사용자 색 조정을 구워 넣는다.
 *
 * ── 왜 판정과 적용을 나누는가 ────────────────────────────────────────────
 *
 * `simulate`의 색역 판정(레드/옐로/…)과 커브는 **sRGB 0~255를 전제로** 맞춰져
 * 있다. 컬러휠에 보이는 대로 동작하려면 그 공간에서 판정해야 한다.
 *
 * 그런데 이전 구현은 판정만이 아니라 **적용까지 sRGB에서 하고 되돌렸다.**
 *
 *     ProPhoto → sRGB → 그레이딩 → ProPhoto
 *
 * 변환이 [0,1]로 클램프하므로 **sRGB 색역 밖 색이 그 자리에서 잘렸다.** 손대지
 * 않은 색까지 전부 왕복하므로 피해가 넓었다 — 실측에서 33³ 격자점의 82.5%가
 * 1/255 이상 이동했고 최대 이동이 0.658이었다. 포화 적색의 채도가 무너졌다.
 * ProPhoto로 작업하는 의미가 그레이딩을 켜는 순간 사라진 셈이다.
 *
 * 그렇다고 클램프만 풀 수도 없다. `simulate`의 커브는 0~255 컨트롤 포인트를
 * 룩업하므로 범위 밖 입력을 양 끝으로 눌러 버린다. 즉 **그레이딩 수식 자체가
 * 유한 범위를 전제한다.**
 *
 * 그래서 이렇게 한다.
 *
 *   1. 클램프한 sRGB **대리색**으로 그레이딩을 돌린다 (기존 경로 그대로)
 *   2. 그 결과에서 **채널별 조정량**을 뽑는다
 *   3. 조정량을 **클램프하지 않은 선형광**에 적용한다
 *
 * 색역 안에서는 대리색이 곧 원래 색이므로 **결과가 이전과 완전히 같다.**
 * 색역 밖에서는 조정량만 옮겨 실려 색이 잘리지 않는다.
 *
 * ── 조정량을 곱으로 볼 것인가 합으로 볼 것인가 ────────────────────────
 *
 * 밝은 쪽은 비율이 맞다(노출을 반으로 줄이면 모든 값이 반이 된다). 어두운 쪽은
 * 합이 맞다 — 대리색이 0인데 결과가 0이 아니면(발끝 리프트 등) 비율이 무한대가
 * 된다. 그래서 대리색 밝기로 둘을 섞는다.
 *
 * **색역 안에서는 두 방식이 같은 값을 낸다**(대리색 = 원래 색이므로 곱하든 더하든
 * 결과가 `after`가 된다). 그래서 섞는 비율이 무엇이든 회귀가 없다.
 */

/** 곱 ↔ 합 전환 구간 (선형광). 이 아래는 합, 위는 비율. */
const GAIN_FLOOR = 0.01;

function mul3v(m, v, out) {
  out[0] = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2];
  out[1] = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2];
  out[2] = m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2];
}

function bakeGrading(table, grading) {
  const M_TO = colorspace.M_PROPHOTO_TO_SRGB;
  const M_BACK = colorspace.M_SRGB_TO_PROPHOTO;

  const linWork = [0, 0, 0]; // ProPhoto 원색 선형광
  const linSrgb = [0, 0, 0]; // sRGB 원색 선형광 — 색역 밖이면 음수가 된다
  const proxy = [0, 0, 0]; // 클램프한 sRGB 인코딩 대리색 (0~255)
  const out = [0, 0, 0];

  for (let p = 0; p < table.length; p += 3) {
    linWork[0] = colorspace.prophotoDecode(table[p]);
    linWork[1] = colorspace.prophotoDecode(table[p + 1]);
    linWork[2] = colorspace.prophotoDecode(table[p + 2]);

    // 클램프하지 않는다. 여기서 자르면 지금 고치려는 문제가 그대로 남는다.
    mul3v(M_TO, linWork, linSrgb);

    // 대리색 — srgbEncode가 [0,1]로 자른다. **여기서만 자르는 것이 의도다.**
    proxy[0] = colorspace.srgbEncode(linSrgb[0]) * 255;
    proxy[1] = colorspace.srgbEncode(linSrgb[1]) * 255;
    proxy[2] = colorspace.srgbEncode(linSrgb[2]) * 255;

    const graded = simulate.applyGrading(proxy, grading);

    for (let c = 0; c < 3; c++) {
      const before = colorspace.srgbDecode(proxy[c] / 255);
      const after = colorspace.srgbDecode(graded[c] / 255);
      const w = before >= GAIN_FLOOR ? 1 : before / GAIN_FLOOR;
      const ratio = before > 0 ? linSrgb[c] * (after / before) : 0;
      const delta = linSrgb[c] + (after - before);
      out[c] = w * ratio + (1 - w) * delta;
    }

    mul3v(M_BACK, out, linWork);
    table[p] = colorspace.prophotoEncode(linWork[0]);
    table[p + 1] = colorspace.prophotoEncode(linWork[1]);
    table[p + 2] = colorspace.prophotoEncode(linWork[2]);
  }
  return table;
}

/**
 * params에서 최종 LUT을 만든다. 파이프라인·미리보기·팔레트가 모두 이 함수를 쓴다.
 * 세 곳이 각자 LUT을 구우면 조건이 어긋나 서로 다른 결과를 보여주게 된다.
 */
function buildForParams(params, size) {
  const f = params.film || {};
  const filmOn = f.enabled !== false;

  // **필름과 그레이딩은 독립이다.** 필름을 끄면 유제·스캐너만 빠지고, 사용자
  // 색 조정은 그대로 남는다 — 항등에서 시작해 그레이딩만 굽는다.
  //
  // 이전에는 이 함수가 `enabled`를 **아예 보지 않고** 항상 필름을 구웠고,
  // 호출자(파이프라인·미리보기·내보내기)가 각자 검사했다. 그래서 검사 방식이
  // 서로 달라졌다 — 미리보기는 그레이딩을 보여주는데 적용은 아무것도 하지 않고,
  // 내보내기는 에러를 던졌다. 판단을 여기 한 곳으로 모은다.
  const table = filmOn
    ? buildLut(films.byId(f.id), { size, exposure: f.exposure || 0 })
    : lut.identity(size);

  // 유제 → 스캐너 → 사용자 조정 순서다.
  // 스캐너는 인화·스캔 장비의 특성이므로 필름 바로 다음에 와야 하고,
  // 사용자 조정은 완성된 룩 위에 얹는 것이므로 맨 마지막이다.
  //
  // 필름이 꺼져 있으면 스캐너도 걸지 않는다. 스캔할 필름이 없기 때문이다.
  if (filmOn) scanner.bake(table, scanner.byId(f.scanner));

  if (gradingIsActive(params.grading)) bakeGrading(table, params.grading);
  return table;
}

/**
 * 이 파라미터가 색을 실제로 바꾸는가.
 *
 * 둘 다 꺼져 있으면(또는 그레이딩이 중립이면) LUT이 항등이라 적용·내보내기가
 * 의미 없다. **호출자는 `film.enabled`를 직접 보지 말고 이 함수를 쓴다** —
 * 조건을 각자 쓰기 시작하면 또 어긋난다.
 */
function hasEffect(params) {
  if (!params) return false;
  const f = params.film || {};
  return f.enabled !== false || gradingIsActive(params.grading);
}

/**
 * 진단용 요약. 직선부 기울기와 그것이 만드는 실효 대비를 돌려준다.
 * 자리표시자 곡선을 실제 TDS 수치로 교체할 때 값이 말이 되는지 확인하는 용도.
 */
function describe(film) {
  const pg = film.printGamma;
  const info = typeOf(film);
  const out = { id: film.id, type: film.type, printGamma: pg, channels: {} };
  const chans = info.channels === 1 ? ["mono"] : ["r", "g", "b"];
  for (const ch of chans) {
    const pts = film.characteristicCurves[ch] || film.characteristicCurves.g;
    const fn = pchip(pts);
    // H = -1 ~ +1 구간을 직선부로 보고 기울기를 잰다.
    const gamma = (fn(1) - fn(-1)) / 2;
    out.channels[ch] = {
      gamma: Math.round(gamma * 1000) / 1000,
      effectiveContrast: Math.round(gamma * pg * 1000) / 1000,
    };
  }
  return out;
}

/** .cube 헤더에 쓸 제목. 필름·노광을 식별할 수 있게 만든다. */
function lutTitle(film, exposure) {
  const ev = exposure ? (exposure > 0 ? `+${exposure}` : `${exposure}`) : "0.0";
  return `FilmSim ${film.displayName} / ${ev}EV`;
}

module.exports = {
  buildLut,
  buildForParams,
  hasEffect,
  bakeGrading,
  gradingIsActive,
  describe,
  lutTitle,
  WORKING_GAMMA,
  ANCHOR,
};

