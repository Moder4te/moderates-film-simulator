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
 * 입자에 걸리느냐에 따라 **끊겨 흩어진다.**
 *
 * ── 흩어짐 단위 = 입자 크기 (셀) ────────────────────────────────────────
 *
 * 픽셀마다 완전 독립으로 집으면 흩어짐이 **1픽셀 단위**라, 입자가 굵어지면
 * 텍스처는 큰데 흩어짐만 잘아 이질적이다(입자 8 넘으면 어긋남).
 *
 * 그래서 **입자 크기 셀**로 상관시킨다. 한 셀 안의 픽셀은 **같은 오프셋**으로 함께
 * 움직이고(입자 크기 덩어리가 통째로 이동), 셀끼리는 독립이다(경계에서 끊김).
 * 셀 크기 = 입자 크기라 흩어짐 알갱이가 텍스처 알갱이와 같아진다. 셀=1이면
 * per-pixel로 돌아가 미세 입자에서 예전 거동을 유지한다.
 *
 * 셀 내 일정·셀 간 급변이라 매끄러운 장(warp의 꼬불꼬불)과 달리 조각난다.
 * 최근접 샘플(바이리니어 아님)이라 다시 흐려지지 않고 크리스프하다.
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
 * 입자 크기 셀 단위로 이웃을 무작위로 집는다(정수 오프셋, 최근접).
 *
 * @param {object} opts { radius, cell, seed }
 *   radius  덩어리 최대 이동 거리(px).
 *   cell    흩어짐 단위(px) = 입자 크기. 이 크기 셀 안은 함께 움직인다.
 *           1이면 per-pixel(미세 입자). 없으면 1.
 *   seed    주면 결정적. 없으면 Math.random.
 */
function diffuseBuffer(data, w, h, comps, opts) {
  const o = opts || {};
  const rand = o.seed != null ? mulberry32(o.seed) : Math.random;
  const r = Math.max(0, o.radius == null ? 1 : o.radius);
  const cell = Math.max(1, Math.round(o.cell == null ? 1 : o.cell));
  const span = 2 * r;

  // 셀당 오프셋 하나. 셀 내 픽셀은 이걸 공유해 함께 움직인다.
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const ox = new Int16Array(gw * gh);
  const oy = new Int16Array(gw * gh);
  for (let i = 0; i < ox.length; i++) {
    ox[i] = Math.round((rand() - 0.5) * span);
    oy[i] = Math.round((rand() - 0.5) * span);
  }

  const out = new data.constructor(data.length);
  for (let y = 0; y < h; y++) {
    const gy = (y / cell) | 0;
    for (let x = 0; x < w; x++) {
      const gi = gy * gw + ((x / cell) | 0);
      let sx = x + ox[gi];
      let sy = y + oy[gi];
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
