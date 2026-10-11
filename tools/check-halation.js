#!/usr/bin/env node
/**
 * 할레이션 검사 — `core/optics/halation.js`가 지켜야 할 성질을 값으로 못 박는다.
 *
 *   node tools/check-halation.js
 *
 * 예전 PS 필터 체인은 노드에서 못 돌려 검사가 없었다. 그 사이에 Maximum 팽창이
 * 에너지를 안 보존해 작은 반짝임이 큰 덩어리가 되는 결함이 육안으로만 드러났다
 * (2026-10-07). 그 성질부터 막는다.
 */

const h = require("../core/optics/halation");

let pass = true;
const check = (name, ok, detail) => {
  if (!ok) pass = false;
  console.log(`  ${ok ? "OK  " : "❌  "}${name}${detail ? "  " + detail : ""}`);
};

const sum = (a) => a.reduce((s, x) => s + x, 0);

// ── 커널 ──────────────────────────────────────────────────────────────
{
  const w = sum(h.KERNEL.map((k) => k.weight));
  check("커널 가중치 합 = 1 (에너지 보존)", Math.abs(w - 1) < 1e-3, w.toFixed(4));

  // 한가운데 델타를 번지면 총합이 그대로여야 한다(가장자리에 안 닿을 만큼 큰 판)
  const N = 401, R = 12;
  const f = new Float32Array(N * N);
  f[(N >> 1) * N + (N >> 1)] = 1;
  const s = h.spread(f, N, N, R);
  const tot = sum(s);
  check("델타를 번져도 총 에너지 보존", Math.abs(tot - 1) < 0.01, tot.toFixed(4));

  // 반경별 누적 에너지 — 목표 커널 0.6·Exp(0.6R) + 0.4·Exp(2.0R)과 비교
  const c = N >> 1;
  const target = (q) => {
    const e = (l) => 1 - Math.exp(-q / l) * (1 + q / l); // 2D 지수 커널의 반경 q 안 에너지
    return 0.6 * e(0.6) + 0.4 * e(2.0);
  };
  let worst = 0;
  for (const q of [0.5, 1, 2, 4]) {
    let e = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (Math.hypot(x - c, y - c) <= q * R) e += s[y * N + x];
    }
    worst = Math.max(worst, Math.abs(e - target(q)));
  }
  check("반경별 누적 에너지가 지수 커널과 맞는다(±4%)", worst < 0.04, `최대차 ${worst.toFixed(3)}`);
}

// ── 이미지 경로 ──────────────────────────────────────────────────────
function image(w, hgt, fill) {
  const d = new Uint8Array(w * hgt * 3);
  for (let i = 0; i < d.length; i++) d[i] = fill;
  return d;
}
function spot(d, w, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const o = (y * w + x) * 3; d[o] = d[o + 1] = d[o + 2] = 255; }
  }
}
const W = 600, H = 400;
const opts = { maxV: 255, gamma: 2.2, threshold: 150, strength: 50, radiusPx: 12 };
const redAt = (out, x, y) => out[(y * W + x) * 3] - 20;

{
  // 강도 0 · 문턱 넘는 빛 없음 → 아무것도 안 한다
  const d = image(W, H, 20);
  spot(d, W, 300, 200, 20);
  check("강도 0이면 null(레이어 안 만든다)", h.apply(d, W, H, 3, { ...opts, strength: 0 }) === null);
  check("문턱 넘는 빛이 없으면 null", h.apply(image(W, H, 120), W, H, 3, opts) === null);
}

{
  // ⚠️ 이번 재구현의 이유 — 한 점짜리 반짝임은 큰 광원보다 훨씬 약하게 번져야 한다.
  // (Maximum 팽창은 둘을 같은 크기·밝기의 원반으로 만들었다)
  const a = image(W, H, 20); spot(a, W, 300, 200, 0);
  const b = image(W, H, 20); spot(b, W, 300, 200, 20);
  const oa = h.apply(a, W, H, 3, opts), ob = h.apply(b, W, H, 3, opts);
  const ra = redAt(oa, 340, 200), rb = redAt(ob, 340, 200);
  check("작은 반짝임의 헤일로 ≪ 큰 광원의 헤일로", ra * 20 < rb, `광원에서 40px: 점 +${ra} / 원 +${rb}`);

  // 붉다 — 적감층 재노광. G·B 증가가 R보다 작아야 한다
  const o = (200 * W + 340) * 3;
  const dR = ob[o] - 20, dG = ob[o + 1] - 20, dB = ob[o + 2] - 20;
  check("헤일로는 R > G > B", dR > dG && dG >= dB, `+${dR}/+${dG}/+${dB}`);

  // 멀어질수록 단조 감소
  let mono = true, prev = Infinity;
  for (let x = 330; x < 420; x += 10) { const v = redAt(ob, x, 200); if (v > prev) mono = false; prev = v; }
  check("광원에서 멀어질수록 단조 감소", mono);
}

{
  // 해상도 불변 — 반경이 이미지 크기에 비례하면 같은 상대 위치의 값이 같아야 한다
  const small = image(W, H, 20); spot(small, W, 300, 200, 20);
  const W2 = W * 2, H2 = H * 2;
  const big = new Uint8Array(W2 * H2 * 3).fill(20);
  for (let y = 160; y <= 240; y++) for (let x = 260; x <= 340; x++) {
    if ((x - 300) ** 2 + (y - 200) ** 2 <= 400) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const o = ((y * 2 + dy) * W2 + x * 2 + dx) * 3; big[o] = big[o + 1] = big[o + 2] = 255;
      }
    }
  }
  const os = h.apply(small, W, H, 3, opts);
  const ob = h.apply(big, W2, H2, 3, { ...opts, radiusPx: opts.radiusPx * 2 });
  let worst = 0;
  for (const x of [330, 350, 380, 420]) {
    worst = Math.max(worst, Math.abs(os[(200 * W + x) * 3] - ob[(400 * W2 + x * 2) * 3]));
  }
  check("해상도를 두 배로 해도 같은 자리 값이 같다(±3)", worst <= 3, `최대차 ${worst}/255`);
}

console.log(pass ? "\n할레이션 검사 통과" : "\n❌ 할레이션 검사 실패");
process.exit(pass ? 0 : 1);
