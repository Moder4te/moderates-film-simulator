/**
 * 단조 3차 보간 (PCHIP, Fritsch–Carlson).
 *
 * 필름 특성곡선(D-logE)은 제조사 TDS 그래프에서 몇 개 점만 읽어 오므로, 그 사이를
 * 채우는 보간이 필요하다. 일반 3차 스플라인은 샘플 점 사이에서 값이 튀어(overshoot)
 * 원본에 없던 굴곡을 만드는데, 센시토메트리에서는 그게 곧 없던 색 왜곡이 된다.
 * PCHIP은 단조성을 보존해 그 문제가 없다 — 데이터가 단조 증가면 보간도 단조 증가다.
 *
 * v1의 `simulate.js`는 smoothstep 근사를 썼다. 커브 형태를 대충 흉내내는 용도로는
 * 충분했지만, TDS 수치를 그대로 쓰는 v2에서는 데이터를 왜곡하지 않는 보간이어야 한다.
 */

/**
 * 단조 증가하도록 최소제곱 보정한다 (PAVA, pool adjacent violators).
 *
 * 왜 필요한가 — TDS 도면에는 물리적으로 불가능한 구간이 있을 수 있다.
 * Gold 200(E-7022)의 청감층은 발끝에서 농도가 0.992 → 0.965로 **내려갔다가**
 * 다시 오른다. 선 두께보다 큰 하강이라 조판 오차가 아니라 원도면에 그렇게
 * 그려져 있고, 독립 판독 2건이 같은 것을 확인했다. 그러나 노광이 늘면서
 * 농도가 줄어드는 일은 실제 필름에서 일어나지 않는다.
 *
 * 그대로 두면 두 가지가 망가진다.
 *   1. 심부 암부에서 밝아질수록 청색이 어두워진다 (LUT이 비단조).
 *   2. **더 나쁜 쪽** — 곡선 시작점의 기울기가 음수가 되어, 데이터 범위 아래로
 *      선형 외삽할 때 그 음의 기울기가 검정까지 계속 이어진다. 딥 자체보다
 *      외삽으로 번지는 영향이 훨씬 크다(측정: 8비트 4계단).
 *
 * PAVA는 위반 구간만 평균으로 눌러 단조성을 만드는 최소제곱 해라서, 정상
 * 구간의 값은 건드리지 않는다. 위반이 없으면 입력을 그대로 돌려준다.
 */
function monotonic(points) {
  const n = points.length;
  let violated = false;
  for (let i = 1; i < n; i++) {
    if (points[i][1] < points[i - 1][1]) {
      violated = true;
      break;
    }
  }
  if (!violated) return points;

  // 인접 위반 블록을 병합하며 평균으로 대체
  const blocks = []; // { sum, count }
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: points[i][1], count: 1 });
    while (
      blocks.length > 1 &&
      blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count <
        blocks[blocks.length - 2].sum / blocks[blocks.length - 2].count
    ) {
      const b = blocks.pop();
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].count += b.count;
    }
  }

  const out = [];
  let k = 0;
  for (const b of blocks) {
    const v = b.sum / b.count;
    for (let j = 0; j < b.count; j++) out.push([points[k++][0], v]);
  }
  return out;
}

/**
 * 샘플 점으로 보간기를 만든다.
 * @param {Array<[number, number]>} points  [x, y] 배열. x 오름차순이어야 한다.
 * @returns {(x: number) => number}
 */
function pchip(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("pchip: 점이 2개 이상 필요합니다");
  }

  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
    if (i > 0 && xs[i] <= xs[i - 1]) {
      throw new Error(`pchip: x가 오름차순이 아닙니다 (${xs[i - 1]} → ${xs[i]})`);
    }
  }

  // 구간 기울기
  const h = new Float64Array(n - 1);
  const delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = (ys[i + 1] - ys[i]) / h[i];
  }

  // 각 점의 접선 기울기. Fritsch–Carlson 조건으로 단조성을 강제한다.
  const m = new Float64Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      // 부호가 바뀌거나 평평하면 극값이므로 기울기 0 — 여기서 overshoot이 막힌다.
      m[i] = 0;
    } else {
      // 가중 조화평균. 짧은 구간의 기울기에 더 큰 비중을 준다.
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  return function evaluate(x) {
    // 범위 밖은 끝점 기울기로 선형 외삽한다. 특성곡선은 발끝/어깨에서 이미
    // 평탄해지므로 기울기가 작고, 값이 발산하지 않는다.
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);

    // 이진 탐색으로 구간 찾기
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }

    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite 기저
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * ys[lo] + h10 * h[lo] * m[lo] + h01 * ys[lo + 1] + h11 * h[lo] * m[lo + 1];
  };
}

/**
 * 보간기를 균등 격자로 미리 계산해 배열 조회로 바꾼다.
 * LUT을 굽는 동안 격자점마다 이진 탐색을 반복하지 않기 위한 것.
 */
function tabulate(fn, xMin, xMax, steps) {
  const table = new Float64Array(steps);
  const span = xMax - xMin;
  for (let i = 0; i < steps; i++) {
    table[i] = fn(xMin + (span * i) / (steps - 1));
  }
  const scale = (steps - 1) / span;

  return function lookup(x) {
    const p = (x - xMin) * scale;
    if (p <= 0) return table[0];
    if (p >= steps - 1) return table[steps - 1];
    const i = p | 0;
    const f = p - i;
    return table[i] + (table[i + 1] - table[i]) * f;
  };
}

module.exports = { pchip, tabulate, monotonic };
