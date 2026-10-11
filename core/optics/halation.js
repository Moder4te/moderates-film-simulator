/**
 * 할레이션 — 선형광에서 에너지 보존 컨볼루션으로 번진다. 순수 함수(노드에서 검사 가능).
 *
 * 강한 빛이 유제를 지나 베이스 뒷면에서 반사돼 돌아오며 주변을 다시 노광한다. 위층
 * (청감·녹감)과 황색 필터가 짧은 파장을 거의 걸러, 베이스까지 내려가는 것은 **적색광**
 * 이고 다시 노광되는 것도 베이스에 가장 가까운 **적감층**이다 — 그래서 붉다.
 *
 * ── 왜 다시 짰나 (2026-10-07, TODO P0·P2) ──────────────────────────────
 *
 * 예전(PS 필터 체인)은 Maximum 팽창으로 원반을 만들었다. 팽창은 컨볼루션이 아니라
 * "주변 최댓값으로 채우기"라 **에너지를 보존하지 않는다** — 목걸이 반짝임 한 점이
 * 큰 광원과 같은 크기·밝기의 주황 덩어리가 됐다(실사진 `halation_sample/myimage/
 * _DSC0347`). 그리고 감마 공간에서 Color Dodge·Add로 섞어 빛의 덧셈이 아니었다.
 *
 * 여기서는:
 *   1. 인코딩을 풀어 선형으로 (v^γ)
 *   2. 소스 = 적색 선형값의 문턱 초과분 — 작은 점은 에너지가 작아 희미하게, 큰 광원은
 *      진하게 번진다
 *   3. 커널 = 지수 감쇠 두 개(짧은 꼬리 λ=0.6R 60% + 긴 꼬리 λ=2.0R 40%). 원반은
 *      불빛마다 보케 같은 동그라미를 만들어 기각했다(P0 비교)
 *   4. 적감층 재노광 비율(LAYER)로 색을 내 선형에서 더하고 다시 인코딩
 *
 * ── 속도 ──────────────────────────────────────────────────────────────
 *
 * 지수 커널을 **가우시안 4개의 합**으로 근사한다(KERNEL — 반경별 누적 에너지가 목표와
 * 2% 안). 가우시안은 박스블러 3회로(누적합, 반경 무관 O(1)/px), 그것도 **축소본에서**
 * 한다 — 할레이션은 저주파라 가장 작은 σ가 2px 이상 되도록 줄여도 결과가 같다.
 * 풀해상도에서는 소스 축소와 결과 확대(쌍선형)만 돈다.
 */

/** 지수 커널 근사 — σ(반경 R 배수)와 가중치(합 1 = 에너지 보존). 피팅은 위 주석. */
const KERNEL = [
  { sigma: 0.3, weight: 0.0631 },
  { sigma: 0.75, weight: 0.3552 },
  { sigma: 1.7, weight: 0.3707 },
  { sigma: 4.0, weight: 0.211 },
];

/** 적감층 재노광 비율 R:G:B — 녹감층에 조금, 청감층엔 거의 안 닿는다. */
const LAYER = [1.0, 0.07, 0.01];

/** 강도 1당 선형 이득. 기본 강도 50 → 1.8(P0 비교에서 고른 「E 1.8」). */
const GAIN_PER_STRENGTH = 0.036;

/** Ivan Kutskir: 가우시안 σ를 박스블러 3회로 — 각 박스의 반경. */
function boxRadii(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const out = [];
  for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) / 2);
  return out;
}

/** 분리형 박스블러 한 축. 가장자리는 끝 값을 이어 붙인다(광원이 테두리에 걸려도 안 어두워진다). */
function boxPass(src, dst, w, h, r, horizontal) {
  if (r < 1) { dst.set(src); return; }
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  const inv = 1 / (2 * r + 1);
  const last = (len - 1) * step;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    // 클로저 없이 인덱스를 직접 굴린다 — UXP는 JIT이 없어 함수 호출이 비싸다(아래 apply 주석)
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[base + (i < 0 ? 0 : i >= len ? last : i * step)];
    let p = base;
    for (let i = 0; i < len; i++, p += step) {
      dst[p] = acc * inv;
      const ia = i + r + 1, ib = i - r;
      acc += src[base + (ia >= len ? last : ia * step)] - src[base + (ib < 0 ? 0 : ib * step)];
    }
  }
}

function gaussian(field, w, h, sigma, tmp, out) {
  out.set(field);
  for (const r of boxRadii(sigma)) {
    const ri = Math.round(r);
    boxPass(out, tmp, w, h, ri, true);
    boxPass(tmp, out, w, h, ri, false);
  }
}

/**
 * 커널 컨볼루션(이 해상도 그대로). `radiusPx`는 **이 버퍼 기준** R.
 * 테스트가 직접 부른다 — 축소·확대 없이 커널만 본다.
 */
function spread(field, w, h, radiusPx) {
  const acc = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  for (const k of KERNEL) {
    gaussian(field, w, h, k.sigma * radiusPx, tmp, g);
    for (let i = 0; i < acc.length; i++) acc[i] += k.weight * g[i];
  }
  return acc;
}

/**
 * 합성본 → 할레이션이 더해진 합성본. 더할 게 없으면 null(호출부가 레이어를 안 만든다).
 *
 * @param data   chunky RGB(A), Uint8Array 또는 Uint16Array (PS 16bit는 0~32768)
 * @param opts   { maxV, gamma, threshold(0~255 인코딩값), strength(0~100), radiusPx(풀해상도 R) }
 */
function apply(data, width, height, comps, opts) {
  const { maxV, gamma, threshold, strength, radiusPx } = opts;
  const gain = (strength || 0) * GAIN_PER_STRENGTH;
  if (!(gain > 0) || !(radiusPx > 0)) return null;

  // 인코딩 → 선형 표. 16bit도 32769칸이면 충분히 작다
  const lin = new Float32Array(maxV + 1);
  for (let i = 0; i <= maxV; i++) lin[i] = Math.pow(i / maxV, gamma);
  const knee = Math.pow(Math.min(threshold, 254) / 255, gamma);
  const kneeScale = 1 / (1 - knee);

  // ⚠️ **UXP는 JIT이 없는 것처럼 돈다.** 노드 1.7초가 UXP에서 12초였고, `node --jitless`가
  // 14초로 그걸 재현했다. 그래서 픽셀 루프에서 함수 호출(Math.pow·클로저)·나눗셈을 뺀다 —
  // 재인코딩은 표 조회, 쌍선형 좌표·디더는 미리 계산한다. 성능 확인은 --jitless로 할 것.

  // 1) 소스를 축소본에 바로 모은다(면적 평균). 가장 작은 σ가 2px 이상 남게 줄인다
  const f = Math.max(1, Math.floor((KERNEL[0].sigma * radiusPx) / 2));
  const sw = Math.ceil(width / f), sh = Math.ceil(height / f);
  const small = new Float32Array(sw * sh);
  const count = new Float32Array(sw * sh);
  const colBlock = new Int32Array(width);
  for (let x = 0; x < width; x++) colBlock[x] = (x / f) | 0;
  // 문턱 아래는 0 — 소스 값을 코드값 표로 미리 뽑는다
  const srcOf = new Float32Array(maxV + 1);
  for (let i = 0; i <= maxV; i++) srcOf[i] = lin[i] > knee ? (lin[i] - knee) * kneeScale : 0;
  let any = false;
  for (let y = 0, o = 0; y < height; y++) {
    const row = ((y / f) | 0) * sw;
    for (let x = 0; x < width; x++, o += comps) {
      const j = row + colBlock[x];
      count[j]++;
      const s = srcOf[data[o]];
      if (s > 0) { small[j] += s; any = true; }
    }
  }
  if (!any) return null;
  for (let j = 0; j < small.length; j++) small[j] /= count[j];

  // 2) 커널 — 축소본 기준 반경으로
  const halo = spread(small, sw, sh, radiusPx / f);

  // 3) 확대(쌍선형)하며 선형에서 더하고 다시 인코딩. 8bit는 TPDF 디더로 띠를 막는다
  const out = new data.constructor(data.length);
  out.set(data);

  // 재인코딩 표 — √L 공간에서 등간격(암부 정밀도), 칸 사이는 선형 보간
  const EN = 4096;
  const enc = new Float32Array(EN + 2);
  for (let k = 0; k <= EN + 1; k++) enc[k] = Math.pow(Math.min(k / EN, 1), 2 / gamma) * maxV;

  // 쌍선형 — 열 쪽 인덱스·가중치는 한 번만
  const cx0 = new Int32Array(width), cx1 = new Int32Array(width), ctx = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let fx = (x + 0.5) / f - 0.5;
    if (fx < 0) fx = 0;
    const x0 = Math.min(fx | 0, sw - 1);
    cx0[x] = x0; cx1[x] = Math.min(x0 + 1, sw - 1); ctx[x] = fx - x0;
  }

  // 디더 — 64×64 타일의 삼각 분포 ±1 LSB(결정적). 8bit에서만
  const dither = maxV === 255;
  const DT = 64;
  const tile = new Float32Array(DT * DT);
  if (dither) {
    for (let i = 0; i < tile.length; i++) {
      let s = Math.imul(i + 1, 0x9e3779b1);
      s = Math.imul(s ^ (s >>> 15), 0x85ebca6b);
      s ^= s >>> 13;
      tile[i] = ((s & 0xffff) + ((s >>> 16) & 0xffff)) / 65535 - 1;
    }
  }

  const l0 = LAYER[0], l1 = LAYER[1], l2 = LAYER[2];
  for (let y = 0; y < height; y++) {
    let fy = (y + 0.5) / f - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(fy | 0, sh - 1), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    const r0 = y0 * sw, r1 = y1 * sw, dRow = (y % DT) * DT;
    for (let x = 0, o = y * width * comps; x < width; x++, o += comps) {
      const a = halo[r0 + cx0[x]], b = halo[r0 + cx1[x]];
      const c = halo[r1 + cx0[x]], d = halo[r1 + cx1[x]];
      const tx = ctx[x];
      const top = a + (b - a) * tx;
      const hv = gain * (top + (c + (d - c) * tx - top) * ty);
      if (hv <= 1e-7) continue; // 더할 게 없으면 원본 그대로(비트 동일)
      const n = dither ? tile[dRow + (x & 63)] + 0.5 : 0.5;
      for (let ch = 0; ch < 3; ch++) {
        let L = lin[data[o + ch]] + hv * (ch === 0 ? l0 : ch === 1 ? l1 : l2);
        if (L > 1) L = 1;
        const u = Math.sqrt(L) * EN, k = u | 0;
        const v = enc[k] + (enc[k + 1] - enc[k]) * (u - k) + n;
        out[o + ch] = v < 0 ? 0 : v > maxV ? maxV : v | 0;
      }
    }
  }
  return out;
}

module.exports = { apply, spread, KERNEL, LAYER, GAIN_PER_STRENGTH };
