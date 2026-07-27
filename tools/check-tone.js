const tone = require("../core/optics/tone");
const Z = { exposure: 0, contrast: 0, shadows: 0, highlights: 0, black: 0, temp: 0, tint: 0, saturation: 0, vibrance: 0 };
const ramp = () => { const a = new Uint8Array(256 * 3); for (let i = 0; i < 256; i++) { a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = i; } return a; };
let pass = true;
const check = (name, ok, detail) => { if (!ok) pass = false; console.log(`  ${ok ? "OK  " : "❌  "}${name}${detail ? "  " + detail : ""}`); };

// 1 항등
const src = ramp();
const id = tone.apply(src, 3, 256, { maxV: 255, gamma: 2.2, dither: true, seed: 1 }, Z);
let same = true; for (let i = 0; i < 768; i++) if (id[i] !== src[i]) same = false;
check("항등 (전부 0, 디더 켜도 원본 그대로)", same);
check("hasEffect(전부 0) === false", tone.hasEffect(Z) === false);

// 2 단조성 — 무작위 500조합
function rev(g) {
  const o = tone.apply(ramp(), 3, 256, { maxV: 255, gamma: 2.2, dither: false }, g);
  let n = 0, w = 0;
  for (let i = 1; i < 256; i++) for (let c = 0; c < 3; c++) { const d = o[(i - 1) * 3 + c] - o[i * 3 + c]; if (d > 0) { n++; w = Math.max(w, d); } }
  return [n, w];
}
// 결정적 PRNG — 테스트가 실행마다 다른 결과를 내면 안 된다(처음엔 Math.random을
// 썼다가 5회 중 1회 실패하는 flaky 테스트가 됐다)
let seed = 20260727;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const R = (lo, hi) => lo + rnd() * (hi - lo);
let bad = 0, worst = 0;
const N = 5000;
for (let t = 0; t < N; t++) {
  const g = { exposure: R(-2, 2), contrast: R(-50, 50), shadows: R(-100, 100), highlights: R(-100, 100), black: R(0, 50), temp: R(-100, 100), tint: R(-100, 100), saturation: R(-100, 100), vibrance: R(-100, 100) };
  const [n, w] = rev(g); if (n) { bad++; worst = Math.max(worst, w); }
}
// 완전 단조는 성립하지 않는다 — fitGamut(색상 보존 색역 매핑)은 경계 근처에서
// 당김 비율이 비단조로 변할 수 있다. 하드 클립이면 단조롭지만 색상이 틀어진다.
// 그래서 **크기 1레벨 이하 + 빈도 0.1% 미만**을 불변식으로 잡는다.
check("단조성 — 역전은 1레벨 이하", worst <= 1, `최대 ${worst}레벨`);
check("단조성 — 역전 조합 0.1% 미만", bad / N < 0.001, `${bad}/${N} (${(bad / N * 100).toFixed(3)}%)`);
const [ne] = rev({ exposure: 2, contrast: 50, shadows: 100, highlights: 100, black: 50, temp: 100, tint: 100, saturation: 100, vibrance: 100 });
check("단조성 — 전 슬라이더 최대", ne === 0);

// 3 중립 보존
function neutralDev(g) {
  const o = tone.apply(ramp(), 3, 256, { maxV: 255, gamma: 2.2, dither: false }, g);
  let w = 0; for (let i = 0; i < 256; i++) w = Math.max(w, Math.abs(o[i * 3] - o[i * 3 + 2]));
  return w;
}
check("중립 보존 — 톤 조정이 색을 만들지 않음", neutralDev({ ...Z, exposure: 1, contrast: 40, shadows: 60, black: 20 }) === 0);
check("중립 보존 — 채도 최대에서도", neutralDev({ ...Z, saturation: 100, vibrance: 100 }) === 0);

// 3b 화이트밸런스가 무채색 밝기를 보존하는가 (정규화 이득으로 바꾼 부분)
const gray = new Uint8Array(3); gray[0] = gray[1] = gray[2] = 128;
for (const [tm, tn] of [[100, 0], [-100, 0], [0, 100], [0, -100], [60, -40]]) {
  const o = tone.apply(gray, 3, 1, { maxV: 255, gamma: 2.2, dither: false }, { ...Z, temp: tm, tint: tn });
  const L = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
  check(`화이트밸런스 광도 보존 temp${tm} tint${tn}`, Math.abs(L - 128) <= 1.5, `광도 ${L.toFixed(1)} / 128`);
}

// 4 색상 보존
function hue(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0; let h; if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4; return (h * 60 + 360) % 360; }
const cols = [[200, 80, 70], [90, 160, 60], [70, 90, 200], [210, 180, 60], [150, 60, 150]];
const buf = new Uint8Array(cols.length * 3); cols.forEach((c, i) => { buf[i * 3] = c[0]; buf[i * 3 + 1] = c[1]; buf[i * 3 + 2] = c[2]; });
const sat = tone.apply(buf, 3, cols.length, { maxV: 255, gamma: 2.2, dither: false }, { ...Z, saturation: 100, exposure: 0.7 });
let hw = 0; cols.forEach((c, i) => { let d = Math.abs(hue(sat[i * 3], sat[i * 3 + 1], sat[i * 3 + 2]) - hue(c[0], c[1], c[2])); if (d > 180) d = 360 - d; hw = Math.max(hw, d); });
check("색역 이탈 시 색상 보존 (하드클립 아님)", hw < 3, `최대 색상 이동 ${hw.toFixed(2)}°`);

// 5 16bit / 알파
const b16 = new Uint16Array(9); b16[0] = 8000; b16[1] = 16000; b16[2] = 24000; b16[6] = b16[7] = b16[8] = 32768;
const o16 = tone.apply(b16, 3, 3, { maxV: 32768, gamma: 1.8, dither: false }, { ...Z, exposure: 0.5 });
check("16bit — 타입·상한 유지", o16.constructor.name === "Uint16Array" && Math.max(...o16) <= 32768 && o16[6] === 32768);
const rgba = new Uint8Array([100, 120, 140, 77, 200, 200, 200, 255]);
const oa = tone.apply(rgba, 4, 2, { maxV: 255, gamma: 2.2, dither: false }, { ...Z, contrast: 40 });
check("알파 보존", oa[3] === 77 && oa[7] === 255);

// 6 디더 효과 — 최악 조건(좁은 암부 확대)에서 띠가 부서지는가
const W = 600; const grad = new Uint8Array(W * 3);
for (let i = 0; i < W; i++) { const v = Math.round(8 + i / (W - 1) * 16); grad[i * 3] = grad[i * 3 + 1] = grad[i * 3 + 2] = v; }
const P = { ...Z, exposure: 1.5, shadows: 80 };
function avgRun(b) { const v = []; for (let i = 0; i < W; i++) v.push(b[i * 3]); const runs = []; let r = 1; for (let i = 1; i < W; i++) { if (v[i] === v[i - 1]) r++; else { runs.push(r); r = 1; } } runs.push(r); return runs.reduce((a, b) => a + b, 0) / runs.length; }
const nd = avgRun(tone.apply(grad, 3, W, { maxV: 255, gamma: 2.2, dither: false }, P));
const wd = avgRun(tone.apply(grad, 3, W, { maxV: 255, gamma: 2.2, dither: true, seed: 3 }, P));
check("디더가 띠를 부순다", wd < nd / 5, `평균 띠폭 ${nd.toFixed(1)}px → ${wd.toFixed(1)}px`);

// 7 디더 편향 없음
let s1 = 0, s2 = 0; const NF = 4096;
const flat = new Uint8Array(NF * 3); for (let i = 0; i < NF; i++) { flat[i * 3] = flat[i * 3 + 1] = flat[i * 3 + 2] = 100; }
const f1 = tone.apply(flat, 3, NF, { maxV: 255, gamma: 2.2, dither: false }, { ...Z, exposure: 0.33 });
const f2 = tone.apply(flat, 3, NF, { maxV: 255, gamma: 2.2, dither: true, seed: 5 }, { ...Z, exposure: 0.33 });
for (let i = 0; i < NF; i++) { s1 += f1[i * 3]; s2 += f2[i * 3]; }
check("디더가 평균값을 밀지 않음", Math.abs(s1 / NF - s2 / NF) < 0.6, `편향 ${Math.abs(s1 / NF - s2 / NF).toFixed(3)}`);

console.log(pass ? "\n✅ 전 항목 통과" : "\n❌ 실패 항목 있음");
process.exit(pass ? 0 : 1);
