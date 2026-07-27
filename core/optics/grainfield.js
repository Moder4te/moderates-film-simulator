/**
 * 그레인 필드 — **값 노이즈(value noise)**로 다이클라우드를 만든다.
 *
 * ── 왜 블러가 아니라 값 노이즈인가 ──────────────────────────────────────
 *
 * 예전엔 1px 백색 노이즈를 가우시안으로 뭉쳐 큰 입자를 흉내 냈다. 이게 근본
 * 결함이었다 — **가우시안 블러는 큰 blob을 못 만든다.** 반경을 키우면 상관은
 * 늘지만 **대비가 같이 떨어져** 밋밋한 mush가 된다. 입자가 커지는 게 아니라
 * 흐려지는 것이라, 입자처럼 안 보인다(사용자 지적).
 *
 * 값 노이즈는 다르다. 셀(격자) 마디마다 난수를 두고 부드럽게 보간하면, **셀 크기의
 * blob이 대비를 온전히 유지한 채** 생긴다. 셀을 키우면 blob이 **실제로 커진다** —
 * 대비 손실 없이. 이게 다이클라우드가 커지는 거동이다.
 *
 * 광대역: 미세 옥타브(cell) + 덩어리 옥타브(cell×2.6)를 합쳐 "고운 입자 위에 큰
 * 덩어리"를 낸다. 채널별 진폭(청색을 시끄럽게)도 여기서 준다.
 *
 * 출력은 mid(중성 회색) 중심의 버퍼다. 호출자가 Overlay로 얹으면 mid는 무변화,
 * 편차가 밝게/어둡게 변조한다. 순수 함수 — imaging은 호출자 몫이다.
 */

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

function smooth(t) {
  return t * t * (3 - 2 * t); // smoothstep — 둥근 blob
}

/**
 * 값 노이즈 한 옥타브를 out(Float32, w*h)에 **가산**한다. 범위 대략 [-weight, weight].
 * cell = blob 크기(px). 클수록 큰 blob, 대비는 그대로.
 */
function addOctave(out, w, h, cell, weight, rand) {
  const step = Math.max(1, cell);
  const gw = Math.ceil(w / step) + 2;
  const gh = Math.ceil(h / step) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = (rand() * 2 - 1) * weight;

  for (let y = 0; y < h; y++) {
    const fy = y / step;
    const y0 = fy | 0;
    const ty = smooth(fy - y0);
    const r0 = y0 * gw;
    const r1 = (y0 + 1) * gw;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      const x0 = fx | 0;
      const tx = smooth(fx - x0);
      const top = g[r0 + x0] * (1 - tx) + g[r0 + x0 + 1] * tx;
      const bot = g[r1 + x0] * (1 - tx) + g[r1 + x0 + 1] * tx;
      out[y * w + x] += top * (1 - ty) + bot * ty;
    }
  }
}

/**
 * 한 채널 값 노이즈 필드(Float32, 대략 [-1,1] 정규화). 미세 + 덩어리 옥타브 합.
 */
function channelField(w, h, cell, clumpScale, rand) {
  const f = new Float32Array(w * h);
  // 미세 옥타브(주). 덩어리 옥타브(cell×2.6, clumpScale 비중).
  const base = 1;
  const clump = clumpScale;
  addOctave(f, w, h, cell, base, rand);
  if (clump > 0) addOctave(f, w, h, cell * 2.6, clump, rand);
  const norm = 1 / (base + clump); // 대략 [-1,1]로
  for (let i = 0; i < f.length; i++) f[i] *= norm;
  return f;
}

/**
 * 그레인 버퍼를 만든다. mid 중심, comps 인터리브, data 타입(8/16bit)에 맞춘다.
 *
 * @param {object} opts
 *   cell      blob 크기 px (= 입자 크기)
 *   comps     채널 수
 *   mid       중성값 (Overlay 무변화점). 8bit 128, PS 16bit 16384.
 *   maxV      클램프 상한. 8bit 255, PS 16bit 32768(65535 아님).
 *   amp       편차 진폭 (mid 대비, 0~1). Overlay 변조 세기.
 *   amps      {r,g,b} 채널별 진폭 배수 (색 그레인). 없으면 모노(전 채널 동일).
 *   clumpScale 덩어리 옥타브 비중 0~1
 *   seed
 * @returns {Uint8Array|Uint16Array}
 */
function generate(w, h, comps, opts) {
  const o = opts || {};
  const cell = Math.max(1, o.cell || 1);
  const mid = o.mid == null ? 128 : o.mid;
  const maxV = o.maxV == null ? 255 : o.maxV;
  const amp = (o.amp == null ? 0.5 : o.amp) * mid;
  const clumpScale = o.clumpScale || 0;
  const out = maxV > 255 ? new Uint16Array(w * h * comps) : new Uint8Array(w * h * comps);
  const baseSeed = (o.seed == null ? 1 : o.seed) >>> 0;

  const mono = !o.amps;
  // 모노면 한 필드를 공유(전 채널 동일 = 무채색 그레인). 색이면 채널마다 독립.
  const fields = [];
  if (mono) {
    const f = channelField(w, h, cell, clumpScale, mulberry32(baseSeed));
    for (let c = 0; c < comps; c++) fields.push(f);
  } else {
    const ampsArr = [o.amps.r, o.amps.g, o.amps.b];
    for (let c = 0; c < comps; c++) {
      // 채널마다 다른 시드로 독립. 알파(c>2)는 노이즈 없이 필드 0.
      if (c > 2) { fields.push(null); continue; }
      fields.push(channelField(w, h, cell, clumpScale, mulberry32(baseSeed + c * 101)));
    }
  }
  const chanAmp = mono ? [1, 1, 1, 1] : [o.amps.r, o.amps.g, o.amps.b, 0];

  for (let p = 0; p < w * h; p++) {
    const o2 = p * comps;
    for (let c = 0; c < comps; c++) {
      const f = fields[c];
      if (!f) { out[o2 + c] = maxV; continue; } // 알파 불투명
      let v = mid + f[p] * amp * (chanAmp[c] == null ? 1 : chanAmp[c]);
      out[o2 + c] = v < 0 ? 0 : v > maxV ? maxV : v;
    }
  }
  return out;
}

module.exports = { generate, channelField, mulberry32 };
