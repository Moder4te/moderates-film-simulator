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
 *
 * ── 옥타브 회전 (G5) ────────────────────────────────────────────────────
 *
 * 격자를 이미지 축에 그대로 맞춰 샘플링하면 smoothstep 마디가 가로세로로
 * 정렬돼 눈에 띄는 격자 무늬가 생긴다. 옥타브 두 장(미세·덩어리)이 같은 축에
 * 정렬되면 둘이 겹쳐 더 심해진다. 각 옥타브를 서로 다른 각도로 돌려 샘플링하면
 * 이미지 축과도, 서로와도 정렬이 풀린다(실측 — 격자 점수 0.077→0.018, 4.3배
 * 감소, 대비 손실 5%). 오프셋(같은 각도로 밀기)은 안 통한다 — 각 옥타브가
 * 자기 축 정렬 격자를 그대로 갖기 때문에 회전이 답이다.
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

// 미세 옥타브·덩어리 옥타브에 서로 다른 각도를 준다. 둘 다 0·45·90°류의
// 축 정렬을 피하고, 서로도 겹치지 않게 충분히 떨어뜨린다(실측 근거는 파일 머리
// 주석 "옥타브 회전" 절). 값 자체보다 "정렬을 피한다"는 성질이 중요해 상수로 둔다.
const BASE_ANGLE = 0.35; // ≈20°
const CLUMP_ANGLE = 1.15; // ≈66°

/**
 * 격자 마디값 — **배열에 저장하지 않고 좌표에서 해시로 뽑는다.**
 *
 * 회전(G5) 때문에 격자가 이미지 **대각선**을 덮어야 해서, 저장 방식이면 배열이
 * 회전 전의 2.17배가 된다(3:2 기준). 보통은 `cell ∝ 장변`이라 격자 크기가 문서
 * 크기와 무관하게 고정되지만, 「입자 크기 기준」을 고정값(6000px·9000px·직접입력)으로
 * 두고 큰 문서를 작업하면 그 관계가 끊긴다 — 실측 266MP·기준 6000px·ISO 400에서
 * 격자만 **383MB → 831MB**. 이 파일이 "266MP에서 필드 3GB로 메모리가 터졌다"고
 * 적고 채널-메이저로 고친 바로 그 자리다.
 *
 * 값 노이즈는 마디값이 **좌표의 결정적 난수**이기만 하면 되므로 저장할 이유가 없다.
 * 해시로 바꾸면 배열이 통째로 사라져 회전 이전보다도 가볍고, 격자 경계를 벗어난
 * 인덱스라는 개념 자체가 없어져 여유분(+3) 계산도 필요 없다.
 */
function latticeValue(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1; // [-1, 1)
}

/**
 * 값 노이즈 한 옥타브를 out(Float32, w*h)에 **가산**한다. 범위 대략 [-weight, weight].
 * cell = blob 크기(px). 클수록 큰 blob, 대비는 그대로. angle(라디안)만큼 격자를
 * 회전해 샘플링한다 — 격자 마디가 이미지 축·다른 옥타브와 정렬되지 않게(G5).
 *
 * `rand`는 **옥타브 시드를 한 번 뽑는 데만** 쓴다(마디값은 해시가 낸다). 호출
 * 규약은 그대로라 `channelField`·검사 쪽은 손댈 것이 없다.
 */
function addOctave(out, w, h, cell, weight, rand, angle) {
  const step = Math.max(1, cell);
  const a = angle || 0;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  // 회전 좌표가 음수로 가지 않도록 대각 반지름만큼 민다. 해시라 범위 상한은 무관.
  const half = Math.sqrt(w * w + h * h) / 2;
  const seed = (rand() * 4294967296) >>> 0;

  // 이웃 픽셀은 대개 같은 셀에 떨어진다(step ≥ 1). 마디 4개를 캐시해 해시 호출을
  // 줄인다 — cell이 클수록 적중률이 높고, cell=1(최악)이어도 저장 방식과 비슷하다.
  let lx = 0x7fffffff, ly = 0x7fffffff;
  let v00 = 0, v10 = 0, v01 = 0, v11 = 0;

  for (let y = 0; y < h; y++) {
    const dy0 = y - cy;
    for (let x = 0; x < w; x++) {
      const dx0 = x - cx;
      const rx = (dx0 * cosA - dy0 * sinA + half) / step;
      const ry = (dx0 * sinA + dy0 * cosA + half) / step;
      const x0 = Math.floor(rx);
      const y0 = Math.floor(ry);
      if (x0 !== lx || y0 !== ly) {
        v00 = latticeValue(x0, y0, seed);
        v10 = latticeValue(x0 + 1, y0, seed);
        v01 = latticeValue(x0, y0 + 1, seed);
        v11 = latticeValue(x0 + 1, y0 + 1, seed);
        lx = x0;
        ly = y0;
      }
      const tx = smooth(rx - x0);
      const ty = smooth(ry - y0);
      const top = v00 * (1 - tx) + v10 * tx;
      const bot = v01 * (1 - tx) + v11 * tx;
      out[y * w + x] += (top * (1 - ty) + bot * ty) * weight;
    }
  }
}

/**
 * 한 채널 값 노이즈 필드(Float32, 대략 [-1,1] 정규화). 미세 + 덩어리 옥타브 합.
 */
function channelField(w, h, cell, clumpScale, rand) {
  const f = new Float32Array(w * h);
  // 미세 옥타브(주). 덩어리 옥타브(cell×2.6, clumpScale 비중). 서로 다른 각도로
  // 회전해 격자 정렬을 피한다(G5, 파일 머리 주석 참고).
  const base = 1;
  const clump = clumpScale;
  addOctave(f, w, h, cell, base, rand, BASE_ANGLE);
  if (clump > 0) addOctave(f, w, h, cell * 2.6, clump, rand, CLUMP_ANGLE);
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
 *   cellScale {r,g,b} 채널별 cell 배수(입자 **크기** 분화, G2). 없으면 전 채널 1(항등) —
 *             실측(M1)으로 채우기 전까지는 진폭만 다르고 크기는 같다.
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
  const npx = w * h;
  const out = maxV > 255 ? new Uint16Array(npx * comps) : new Uint8Array(npx * comps);
  const baseSeed = (o.seed == null ? 1 : o.seed) >>> 0;
  const mono = !o.amps;
  const chanAmp = mono ? [1, 1, 1, 1] : [o.amps.r, o.amps.g, o.amps.b, 0];
  const chanCell = mono || !o.cellScale ? [1, 1, 1, 1] : [o.cellScale.r, o.cellScale.g, o.cellScale.b, 1];

  // **채널-메이저로 인터리브한다.** 필드(Float32, npx×4B)를 채널마다 하나씩
  // 만들어 out에 쓰고 즉시 버린다. 예전엔 색 모드에서 3개를 동시에 들고 있어
  // 대형 문서(266MP → 필드만 3GB)에서 메모리가 터졌다. 이제 한 번에 하나만 산다.
  // 모노는 한 필드를 전 채널이 공유하므로 애초에 하나뿐이다.
  if (mono) {
    const f = channelField(w, h, cell, clumpScale, mulberry32(baseSeed));
    for (let p = 0; p < npx; p++) {
      let v = mid + f[p] * amp;
      v = v < 0 ? 0 : v > maxV ? maxV : v;
      v = (v + 0.5) | 0;
      const o2 = p * comps;
      for (let c = 0; c < comps; c++) out[o2 + c] = c > 2 ? maxV : v;
    }
    return out;
  }

  for (let c = 0; c < comps; c++) {
    if (c > 2) { for (let p = 0; p < npx; p++) out[p * comps + c] = maxV; continue; } // 알파
    const ca = chanAmp[c] == null ? 1 : chanAmp[c];
    const cc = chanCell[c] == null ? 1 : chanCell[c];
    // 채널마다 다른 시드 → 독립. 루프 끝나면 f는 참조가 끊겨 다음 채널 전에 GC된다.
    const f = channelField(w, h, cell * cc, clumpScale, mulberry32(baseSeed + c * 101));
    for (let p = 0; p < npx; p++) {
      let v = mid + f[p] * amp * ca;
      v = v < 0 ? 0 : v > maxV ? maxV : v;
      out[p * comps + c] = (v + 0.5) | 0;
    }
  }
  return out;
}

module.exports = { generate, channelField, mulberry32 };
