/**
 * 그레인 확산(diffuse) — 픽셀마다 이웃을 무작위로 집어 입자보다 고운 디테일을
 * **조각낸다.**
 *
 * ── 왜 상관 변위장이 아니라 per-pixel인가 ──────────────────────────────
 *
 * 처음엔 매끄러운 상관 벡터장으로 픽셀을 밀었다. 그러면 이웃이 **함께** 움직여
 * 선이 연결된 채 휘어진다 — liquify 같은 꼬불꼬불한 warp이지 그레인이 아니다.
 *
 * 실제 필름(과 Photoshop Diffuse)은 다르다. 입자마다 독립이라, 미세 선이 어느
 * 입자에 걸리느냐에 따라 **끊겨 흩어진다.** 그래서 픽셀마다 **탈상관** 오프셋으로
 * 반경 안의 이웃을 최근접으로 집는다. 이웃끼리 독립이라 선이 조각나고, 평탄한
 * 영역은 이웃이 비슷해 거의 그대로 남는다.
 *
 * 최근접 샘플(바이리니어 아님)이라 다시 흐려지지 않고 크리스프하게 조각난다.
 *
 * 전부 순수 함수다. Photoshop imaging은 호출자가 픽셀을 넣고 뺀다.
 */

/** 결정적 PRNG (mulberry32). 테스트 재현용. 실사용은 시드를 달리 준다. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 픽셀마다 반경 안의 이웃을 무작위로 집는다(정수 오프셋, 최근접).
 *
 * @param {object} opts { radius, seed }
 *   radius  최대 이웃 거리(px). 입자 스케일로 준다.
 *   seed    주면 결정적. 없으면 Math.random.
 */
function diffuseBuffer(data, w, h, comps, opts) {
  const o = opts || {};
  const rand = o.seed != null ? mulberry32(o.seed) : Math.random;
  const r = Math.max(0, o.radius == null ? 1 : o.radius);
  const out = new data.constructor(data.length);
  const span = 2 * r;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 탈상관: 픽셀마다 독립 난수. 상관이 없어 선이 휘지 않고 조각난다.
      let sx = x + Math.round((rand() - 0.5) * span);
      let sy = y + Math.round((rand() - 0.5) * span);
      if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
      const si = (sy * w + sx) * comps;
      const oi = (y * w + x) * comps;
      for (let c = 0; c < comps; c++) out[oi + c] = data[si + c];
    }
  }
  return out;
}

module.exports = { mulberry32, diffuseBuffer };
