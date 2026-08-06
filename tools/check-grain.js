#!/usr/bin/env node
/**
 * 그레인 검사 — docs/PLAN-GRAIN-2026-08-02.md "## 검증" 표를 값으로 못 박는다.
 *
 *   node tools/check-grain.js
 *
 * G2·G3는 아직 실측 상수가 없다(항등 1) — 완전한 검사(R<G<B 순서, 확대 후 실제
 * RMS 보존율)는 M1 실측이 채워진 뒤에나 의미가 있다. 지금은 **손잡이가 항등일 때
 * 아무것도 안 틀어지는지**만 확인한다.
 */

const grainfield = require("../core/optics/grainfield");
const { zoneRanges, blendWeight } = require("../core/optics/grainzones");

let pass = true;
const check = (name, ok, detail) => {
  if (!ok) pass = false;
  console.log(`  ${ok ? "OK  " : "❌  "}${name}${detail ? "  " + detail : ""}`);
};

function std(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / a.length);
}
function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return cov / Math.sqrt(va * vb);
}

// ── G1 — 채널 간 상관 ───────────────────────────────────────────────────
{
  const w = 256, h = 256;
  const rgbBuf = grainfield.generate(w, h, 3, {
    cell: 6, mid: 128, maxV: 255, amp: 0.5,
    amps: { r: 1.23, g: 1.0, b: 1.76 }, clumpScale: 0.3, seed: 7,
  });
  const R = [], G = [], B = [];
  for (let p = 0; p < w * h; p++) { R.push(rgbBuf[p * 3]); G.push(rgbBuf[p * 3 + 1]); B.push(rgbBuf[p * 3 + 2]); }
  const rg = Math.abs(corr(R, G)), gb = Math.abs(corr(G, B)), rb = Math.abs(corr(R, B));
  check("G1 — rgb 모드 채널간 상관이 0에 가깝다", rg < 0.05 && gb < 0.05 && rb < 0.05, `RG=${rg.toFixed(4)} GB=${gb.toFixed(4)} RB=${rb.toFixed(4)}`);

  const g_amp = std(G);
  const rRatio = std(R) / g_amp, bRatio = std(B) / g_amp;
  check("G1 — 진폭비가 amps 입력과 맞는다(±5%)", Math.abs(rRatio - 1.23) < 0.06 && Math.abs(bRatio - 1.76) < 0.09, `R/G=${rRatio.toFixed(3)} B/G=${bRatio.toFixed(3)}`);

  const monoBuf = grainfield.generate(w, h, 3, { cell: 6, mid: 128, maxV: 255, amp: 0.5, clumpScale: 0.3, seed: 7 });
  const R2 = [], G2 = [];
  for (let p = 0; p < w * h; p++) { R2.push(monoBuf[p * 3]); G2.push(monoBuf[p * 3 + 1]); }
  check("G1 — mono 모드는 채널 상관이 정확히 1(공유 필드)", corr(R2, G2) > 0.9999, `corr=${corr(R2, G2).toFixed(6)}`);
}

// ── G2 — 채널별 cell(크기) 손잡이가 항등일 때 무해함 ───────────────────
{
  const w = 256, h = 256;
  const identityBuf = grainfield.generate(w, h, 3, {
    cell: 6, mid: 128, maxV: 255, amp: 0.5,
    amps: { r: 1.23, g: 1.0, b: 1.76 }, cellScale: { r: 1, g: 1, b: 1 }, clumpScale: 0, seed: 3,
  });
  const noCellScaleBuf = grainfield.generate(w, h, 3, {
    cell: 6, mid: 128, maxV: 255, amp: 0.5,
    amps: { r: 1.23, g: 1.0, b: 1.76 }, clumpScale: 0, seed: 3,
  });
  let same = true;
  for (let i = 0; i < identityBuf.length; i++) if (identityBuf[i] !== noCellScaleBuf[i]) same = false;
  check("G2 — cellScale 항등(1,1,1)은 생략과 바이트 단위로 같다", same);
  console.log("      (R<G<B 크기 순서 검사는 M1 실측 후 — 지금은 항등이라 의미 없음)");
}

// ── G3 — 레이어 확대가 대비(RMS)를 블러보다 잘 보존하는가 ──────────────
{
  // 간이 bilinear 확대 — Photoshop scaleLayer(bilinear)와 같은 보간 방식을
  // 흉내낸다. 실측(문서)과 같은 방향성(확대>블러)을 재확인하는 용도.
  function bilinearScale(src, w, h, factor) {
    const nw = Math.round(w * factor), nh = Math.round(h * factor);
    const out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1.001, y / factor);
      const y0 = sy | 0, ty = sy - y0;
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(w - 1.001, x / factor);
        const x0 = sx | 0, tx = sx - x0;
        const a = src[y0 * w + x0], b = src[y0 * w + x0 + 1];
        const c = src[(y0 + 1) * w + x0], d = src[(y0 + 1) * w + x0 + 1];
        out[y * nw + x] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      }
    }
    return { data: out, w: nw, h: nh };
  }
  function boxBlur(src, w, h, radius) {
    const out = new Float32Array(w * h);
    const r = Math.round(radius);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[yy * w + xx]; n++;
          }
        }
        out[y * w + x] = sum / n;
      }
    }
    return out;
  }

  const w = 128, h = 128;
  const field = grainfield.channelField(w, h, 6, 0, grainfield.mulberry32(11));
  const baseRms = std(field);

  const scaled = bilinearScale(field, w, h, 1.35);
  const scaledRms = std(scaled.data);

  const blurred = boxBlur(field, w, h, 3);
  const blurredRms = std(blurred);

  const scaledRetention = scaledRms / baseRms;
  const blurredRetention = blurredRms / baseRms;
  check(
    "G3 — 레이어 확대가 블러보다 대비(RMS)를 잘 보존한다",
    scaledRetention > blurredRetention && scaledRetention > 0.8,
    `확대 ${(scaledRetention * 100).toFixed(0)}% vs 블러 ${(blurredRetention * 100).toFixed(0)}%`
  );
  console.log("      (ZONE_SCALE은 지금 전부 항등 1 — 실제 확대 배율은 M1 실측 후 결정)");
}

// ── G4 — 존 가중치 합이 항상 1인가 ─────────────────────────────────────
//
// **교차점까지 스윕한다.** 예전엔 feather(0~120)만 훑고 c1/c2는 85/170에
// 고정했다 — "crossover는 UI에 없으니 도달 불가능"이라는 이유였다. 그런데
// `zoneRanges`는 `core/`의 공개 순수 함수이고, 이 저장소에서 core 함수의 계약은
// 검사가 정한다. 좁혀 놓은 검사는 **통과 표시를 내면서 함수가 조용히 틀리는 것을
// 가려 줬다** — 실제로 c2=255와 c2<c1에서 가중치 합이 정확히 2가 됐다(그 톤에서
// 그레인이 두 배로 얹힌다). TODO의 ADVANCED 아이디어가 crossover를 슬라이더로
// 빼면 곧바로 열릴 자리이기도 했다.
//
// 지금은 `zoneRanges`가 입력을 [0,254]로 clamp하고 정렬해 **전 함수(total)**가
// 됐으므로, 도달성과 무관하게 전 입력을 훑는다. 도달 가능성으로 검사 범위를
// 좁히면 도달 가능성이 바뀌는 날 조용히 뚫린다.
{
  let maxDev = 0, worst = null;
  for (let c1 = 0; c1 <= 255; c1 += 5) {
    for (let c2 = 0; c2 <= 255; c2 += 5) {
      for (const feather of [0, 1, 10, 40, 85, 120]) {
        const z = zoneRanges(c1, c2, feather);
        for (let L = 0; L <= 255; L += 0.5) {
          const sum = blendWeight(z.shadow, L) + blendWeight(z.midtone, L) + blendWeight(z.highlight, L);
          const dev = Math.abs(sum - 1);
          if (dev > maxDev) { maxDev = dev; worst = `c1=${c1} c2=${c2} f=${feather} L=${L}`; }
        }
      }
    }
  }
  check(
    "G4 — zoneRanges 가중치 합이 전 입력(c1·c2·feather)에서 정확히 1",
    maxDev < 1e-9,
    `최대 이탈 ${maxDev.toExponential(1)}${worst && maxDev >= 1e-9 ? ` (${worst})` : ""}`
  );
}

// ── G5 — 격자 점수가 회전 없는 경우보다 낮은가 ─────────────────────────
{
  function fft1D(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((invert ? 1 : -1) * 2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curWr = 1, curWi = 0;
        for (let j = 0; j < len / 2; j++) {
          const ur = re[i + j], ui = im[i + j];
          const vr = re[i + j + len / 2] * curWr - im[i + j + len / 2] * curWi;
          const vi = re[i + j + len / 2] * curWi + im[i + j + len / 2] * curWr;
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
          const nwr = curWr * wr - curWi * wi;
          curWi = curWr * wi + curWi * wr; curWr = nwr;
        }
      }
    }
  }
  function gridScore(field, size, cell) {
    const re = Float64Array.from(field), im = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      const rowRe = re.subarray(y * size, y * size + size), rowIm = im.subarray(y * size, y * size + size);
      fft1D(rowRe, rowIm, false);
    }
    for (let x = 0; x < size; x++) {
      const colRe = new Float64Array(size), colIm = new Float64Array(size);
      for (let y = 0; y < size; y++) { colRe[y] = re[y * size + x]; colIm[y] = im[y * size + x]; }
      fft1D(colRe, colIm, false);
      for (let y = 0; y < size; y++) { re[y * size + x] = colRe[y]; im[y * size + x] = colIm[y]; }
    }
    const power = new Float64Array(size * size);
    for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    const targetR = size / cell;
    const c = size / 2;
    let axisSum = 0, axisN = 0, ringSum = 0, ringN = 0;
    for (let y = 0; y < size; y++) {
      const fy = y <= c ? y : y - size;
      for (let x = 0; x < size; x++) {
        const fx = x <= c ? x : x - size;
        const r = Math.sqrt(fx * fx + fy * fy);
        if (Math.abs(r - targetR) > 1.5) continue;
        const p = power[y * size + x];
        ringSum += p; ringN++;
        const angDeg = (Math.atan2(fy, fx) * 180) / Math.PI;
        const distToAxis = Math.min(...[0, 90, 180, -90, -180].map((a) => Math.abs(((angDeg - a + 540) % 360) - 180)));
        if (distToAxis < 5) { axisSum += p; axisN++; }
      }
    }
    return (axisSum / Math.max(1, axisN)) / (ringSum / Math.max(1, ringN));
  }

  const size = 256, cell = 8;
  const rotated = grainfield.channelField(size, size, cell, 0, grainfield.mulberry32(1));
  const score = gridScore(rotated, size, cell);
  // 회전 없는 등방 이상치는 1.0(축이 안 튄다) — 여유를 두고 1.3 아래를 임계로 잡는다.
  // (참고: 회전 끄면 이 자리에서 1.48이 나온다 — 실측 스크립트로 확인함)
  check("G5 — 옥타브 회전 후 격자 점수가 임계(1.3) 아래", score < 1.3, `점수=${score.toFixed(3)}`);
}

console.log(pass ? "\n그레인 검사 통과" : "\n그레인 검사 실패");
process.exit(pass ? 0 : 1);
