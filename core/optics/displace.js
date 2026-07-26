/**
 * 그레인 변위 — 픽셀을 입자 스케일로 이동시켜 입자보다 고운 디테일을 부러뜨린다.
 *
 * 블러 디퓨전은 고주파를 **매끈하게** 줄여 미세 선(머리카락)이 흐리게 살아남는다.
 * 필름은 그렇지 않다. 입자가 곧 표본이라, 입자보다 고운 디테일은 어느 입자에
 * 걸리느냐에 따라 **확률적으로 조각난다.** 변위가 그 거동이다 — 픽셀을 국소적으로
 * 조금씩 옮기면 미세 선이 입자 스케일로 끊기고, 굵은 구조는 다 함께 옮겨져 형태를
 * 지킨다. 에너지를 없애지 않고 흐트러뜨린다.
 *
 * 전부 순수 함수다. Photoshop imaging은 호출자(마감 앱)가 픽셀을 넣고 뺀다.
 * batchPlay의 Diffuse 디스크립터가 미채록이라 그걸 추측하는 대신 여기서 직접 한다.
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
 * 변위장 두 벌(dx, dy)을 만든다.
 *
 * 거친 격자에 난수를 두고 바이리니어로 확대해 **상관길이 corrPx**의 매끄러운
 * 벡터장을 얻는다. 백색 지터가 아니라 입자 스케일로 상관돼야 입자가 뭉쳐 움직이는
 * 것처럼 보인다. 진폭은 ampPx(RMS 대략).
 *
 * @returns {{dx:Float32Array, dy:Float32Array}} 길이 w*h
 */
function buildField(w, h, ampPx, corrPx, rng) {
  const rand = rng || Math.random;
  const step = Math.max(1, corrPx);
  const gw = Math.ceil(w / step) + 2;
  const gh = Math.ceil(h / step) + 2;

  const gx = new Float32Array(gw * gh);
  const gy = new Float32Array(gw * gh);
  for (let i = 0; i < gx.length; i++) {
    gx[i] = (rand() * 2 - 1) * ampPx;
    gy[i] = (rand() * 2 - 1) * ampPx;
  }

  const dx = new Float32Array(w * h);
  const dy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / step;
    const y0 = fy | 0;
    const ty = fy - y0;
    const r0 = y0 * gw;
    const r1 = (y0 + 1) * gw;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      const x0 = fx | 0;
      const tx = fx - x0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i = y * w + x;
      dx[i] = gx[r0 + x0] * w00 + gx[r0 + x0 + 1] * w10 + gx[r1 + x0] * w01 + gx[r1 + x0 + 1] * w11;
      dy[i] = gy[r0 + x0] * w00 + gy[r0 + x0 + 1] * w10 + gy[r1 + x0] * w01 + gy[r1 + x0 + 1] * w11;
    }
  }
  return { dx, dy };
}

/**
 * 변위장으로 리샘플한다. out[x,y] = 바이리니어(data, x+dx, y+dy).
 *
 * 좌표는 가장자리에서 클램프한다. 채널 수(comps)를 그대로 보존한다(알파 포함).
 * data는 8/16bit 정수 TypedArray, out은 같은 타입.
 */
function resample(data, w, h, comps, dx, dy, out) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let sx = x + dx[p];
      let sy = y + dy[p];
      if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0;
      const y1 = y0 + 1 < h ? y0 + 1 : y0;
      const tx = sx - x0;
      const ty = sy - y0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i00 = (y0 * w + x0) * comps;
      const i10 = (y0 * w + x1) * comps;
      const i01 = (y1 * w + x0) * comps;
      const i11 = (y1 * w + x1) * comps;
      const o = p * comps;
      for (let c = 0; c < comps; c++) {
        out[o + c] =
          data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
      }
    }
  }
  return out;
}

/**
 * 버퍼를 변위해 새 버퍼를 돌려준다.
 *
 * **거친 격자만 들고 변위를 픽셀마다 인라인 보간한다.** 전체 dx/dy 배열
 * (60MP면 벌당 244MB)을 만들지 않으려는 것이다. buildField/resample은 테스트·소형
 * 용으로 남겨 두고, 실사용 대용량은 이 함수를 쓴다.
 *
 * @param {object} opts { ampPx, corrPx, seed }
 */
function displaceBuffer(data, w, h, comps, opts) {
  const o = opts || {};
  const rand = o.seed != null ? mulberry32(o.seed) : Math.random;
  // `|| 1` 금지 — ampPx 0(변위 없음)이 1로 뒤집힌다.
  const amp = o.ampPx == null ? 1 : o.ampPx;
  const step = Math.max(1, o.corrPx == null ? 1 : o.corrPx);

  const gw = Math.ceil(w / step) + 2;
  const gh = Math.ceil(h / step) + 2;
  const gx = new Float32Array(gw * gh);
  const gy = new Float32Array(gw * gh);
  for (let i = 0; i < gx.length; i++) {
    gx[i] = (rand() * 2 - 1) * amp;
    gy[i] = (rand() * 2 - 1) * amp;
  }

  const out = new data.constructor(data.length);
  for (let y = 0; y < h; y++) {
    const fy = y / step;
    const gy0 = fy | 0;
    const ty = fy - gy0;
    const gr0 = gy0 * gw;
    const gr1 = (gy0 + 1) * gw;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      const gx0 = fx | 0;
      const tx = fx - gx0;
      const b00 = (1 - tx) * (1 - ty);
      const b10 = tx * (1 - ty);
      const b01 = (1 - tx) * ty;
      const b11 = tx * ty;
      const dxv = gx[gr0 + gx0] * b00 + gx[gr0 + gx0 + 1] * b10 + gx[gr1 + gx0] * b01 + gx[gr1 + gx0 + 1] * b11;
      const dyv = gy[gr0 + gx0] * b00 + gy[gr0 + gx0 + 1] * b10 + gy[gr1 + gx0] * b01 + gy[gr1 + gx0 + 1] * b11;

      let sx = x + dxv;
      let sy = y + dyv;
      if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
      const sx0 = sx | 0;
      const sy0 = sy | 0;
      const sx1 = sx0 + 1 < w ? sx0 + 1 : sx0;
      const sy1 = sy0 + 1 < h ? sy0 + 1 : sy0;
      const rx = sx - sx0;
      const ry = sy - sy0;
      const s00 = (1 - rx) * (1 - ry);
      const s10 = rx * (1 - ry);
      const s01 = (1 - rx) * ry;
      const s11 = rx * ry;
      const i00 = (sy0 * w + sx0) * comps;
      const i10 = (sy0 * w + sx1) * comps;
      const i01 = (sy1 * w + sx0) * comps;
      const i11 = (sy1 * w + sx1) * comps;
      const oi = (y * w + x) * comps;
      for (let c = 0; c < comps; c++) {
        out[oi + c] = data[i00 + c] * s00 + data[i10 + c] * s10 + data[i01 + c] * s01 + data[i11 + c] * s11;
      }
    }
  }
  return out;
}

module.exports = { mulberry32, buildField, resample, displaceBuffer };
