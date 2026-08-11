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

// 8 디더가 행 주기로 반복되지 않는가 — **표 길이가 2의 거듭제곱이면 반복한다**
//
// 표 위치는 픽셀마다 3씩 전진하므로 폭 W인 이미지에서 한 행은 3W씩 건너뛴다.
// 표 길이가 65536이고 W가 2048이면 32행마다 3·2048·32 = 196608 ≡ 0 (mod 65536),
// 즉 **32행 뒤 디더가 정확히 제자리로 돌아와 잡음이 그대로 반복된다.**
// 2048·4096은 내보내기 폭으로 흔하다.
//
// 균일한 회색 판에서는 디더가 유일한 변동원이라, 두 행이 같으면 반복이다.
// 표 길이를 소수(65537)로 두면 3W와 인수를 공유할 수 없어 주기가 사라진다.
{
  const WI = 2048, ROWS = 40, LAG = 32; // LAG = 65536 / (3W) 가 정수가 되는 지점
  const plate = new Uint8Array(WI * ROWS * 3);
  plate.fill(100);
  const d = tone.apply(plate, 3, WI * ROWS, { maxV: 255, gamma: 2.2, dither: true, seed: 7 }, { ...Z, exposure: 0.33 });

  let worst = 0, worstRow = -1;
  for (let r = 0; r + LAG < ROWS; r++) {
    const a = (r * WI) * 3, b = ((r + LAG) * WI) * 3;
    let same = 0;
    for (let x = 0; x < WI * 3; x++) if (d[a + x] === d[b + x]) same++;
    const frac = same / (WI * 3);
    if (frac > worst) { worst = frac; worstRow = r; }
  }
  // 옛 구현에서는 1.000(완전 동일)이 나온다. 무관한 두 행은 값이 두어 단계에
  // 몰려 있어 우연 일치가 꽤 높으므로(0.6 근처) 여유를 두고 0.9로 잡는다.
  check(
    "디더가 행 주기로 반복되지 않는다",
    worst < 0.9,
    `폭 ${WI} · ${LAG}행 간격 최대 일치 ${worst.toFixed(3)} (행 ${worstRow})`
  );
}

// ── 작업 색공간 점검 ──────────────────────────────────────────────────
//
// 엔진은 문서가 ProPhoto(γ1.8)라고 **무조건 가정**한다(`film.js`의 WORKING_GAMMA,
// `apply.js`의 getPixels colorSpace:"RGB"). 그 전제가 깨졌을 때 얼마나 어긋나는지를
// 사용자에게 알려 주는 것이 `workingSpaceCheck`이고, **경고 문구에 실린 숫자가
// 실제 오차와 같아야** 경고가 의미를 갖는다. 여기서 그 숫자를 독립적으로 재검산한다.
{
  const cs = require("../core/color/colorspace");

  // S-Log3 전달함수 — 왕복과 규약 상수. Sony 공식과 colour-science 0.4 구현에
  // 편차 0.0으로 일치하는 것을 유도 시점에 확인했다. 여기서는 그 성질을 지킨다.
  {
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const v = i / 2000;
      worst = Math.max(worst, Math.abs(cs.slog3Encode(cs.slog3Decode(v)) - v));
    }
    check("S-Log3 왕복", worst < 1e-12, `최대오차 ${worst.toExponential(1)}`);
    check("S-Log3 18% 그레이 = 420/1023",
      Math.abs(cs.slog3Encode(0.18) - 420 / 1023) < 1e-12,
      cs.slog3Encode(0.18).toFixed(9));
    // 브레이크포인트에서 두 구간이 이어져야 한다. 어긋나면 그 언저리 톤이 튄다.
    const bp = 171.2102946929 / 1023;
    const jump = Math.abs(cs.slog3Decode(bp + 1e-9) - cs.slog3Decode(bp - 1e-9));
    check("S-Log3 브레이크포인트가 연속", jump < 1e-9, `단차 ${jump.toExponential(1)}`);
    // 코드 1.0이 선형 38.4 — 이 값이 hWhite를 정하므로 어긋나면 하이라이트가 밀린다.
    check("S-Log3 코드 1.0 = 선형 38.4",
      Math.abs(cs.slog3Decode(1) - 38.4209) < 1e-3,
      `${cs.slog3Decode(1).toFixed(4)} (= +${Math.log2(cs.slog3Decode(1) / 0.18).toFixed(2)}스톱)`);

    // S-Gamut3.Cine → ProPhoto 행렬. **행합이 1이어야 흰색이 흰색으로 간다** —
    // colour-science의 것은 1.0002까지 벌어져 중성이 미세하게 물든다.
    const M = cs.SGAMUT3CINE_TO_PROPHOTO;
    const rows = M.map((r) => r.reduce((a, b) => a + b, 0));
    check("S-Gamut3.Cine 행렬 행합이 1", rows.every((r) => Math.abs(r - 1) < 1e-7),
      rows.map((r) => r.toFixed(9)).join(" / "));
  }

  // 입력 전달함수의 규약 — `decode`와 `hWhite`가 서로 맞는가.
  //
  // ⚠️ 이걸 따로 박는 이유: `hWhite`는 화이트포인트 롤오프와 리버설 기준점에서만
  // 쓰이는데, **실측 곡선 인화지는 롤오프를 끄고** 리버설 필름은 아직 없다. 그래서
  // 정합성 검사(비대칭 LUT · 기준 그레이)로는 `hWhite`가 틀려도 안 걸린다 —
  // 실제로 상수로 되돌려 봤더니 전 검사를 통과했다. 규약 자체를 여기서 잡는다.
  {
    const inputs = require("../core/color/inputs");
    let worstH = 0, worstMid = 0, names = [];
    for (const i of inputs.all()) {
      worstH = Math.max(worstH, Math.abs(i.hWhite - Math.log10(i.decode(1) / 0.18)));
      // midGrayEncoded를 decode하면 정확히 0.18이어야 한다 — 도구가 놓는 자리와
      // 엔진이 읽는 자리가 같다는 뜻이다.
      worstMid = Math.max(worstMid, Math.abs(i.decode(i.midGrayEncoded) - 0.18));
      names.push(i.id);
    }
    check("입력 hWhite = log10(decode(1)/0.18)", worstH < 1e-12,
      `${names.length}종(${names.join(", ")}) 최대편차 ${worstH.toExponential(1)}`);
    check("입력 midGrayEncoded가 정확히 0.18로 디코드", worstMid < 1e-12,
      `최대편차 ${worstMid.toExponential(1)}`);
    // 리니어 헤드룸은 코드 1.0이 정확히 그 스톱이어야 한다
    for (const n of inputs.HEADROOMS) {
      const i = inputs.byId(`linear-h${n}`);
      check(`리니어 +${n}스톱 코드 1.0 = +${n}스톱`,
        Math.abs(i.hWhite / Math.log10(2) - n) < 1e-12,
        `${(i.hWhite / Math.log10(2)).toFixed(9)}스톱`);
    }
  }

  check("ProPhoto는 통과", cs.workingSpaceCheck("ProPhoto RGB").ok === true);
  check("ROMM도 ProPhoto로 인식", cs.workingSpaceCheck("ROMM RGB").ok === true);
  check("프로파일을 못 읽으면 경고", cs.workingSpaceCheck(null).ok === false);
  check("모르는 공간도 경고", cs.workingSpaceCheck("Display P3").ok === false);

  // 독립 계산: 그 공간에서 선형 L의 인코딩값을 **직접** 만들고, 엔진이 그것을
  // v^1.8로 읽었을 때의 오차를 스톱으로 잰다. colorspace.js의 이분법 역함수와
  // 다른 경로여야 검산이 된다.
  const srgbEnc = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  const adobeEnc = (l) => Math.pow(l, 1 / 2.19921875);
  const stops = (enc, l) => Math.log2(Math.pow(enc(l), 1.8) / l);

  for (const [name, enc] of [["sRGB IEC61966-2.1", srgbEnc], ["Adobe RGB (1998)", adobeEnc]]) {
    const r = cs.workingSpaceCheck(name);
    const dm = Math.abs(r.midGrayStops - stops(enc, 0.18));
    const ds = Math.abs(r.shadowStops - stops(enc, 0.18 / 8));
    check(
      `${name} 오차가 독립 계산과 일치`,
      r.ok === false && dm < 1e-6 && ds < 1e-6,
      `기준 ${r.midGrayStops.toFixed(3)}스톱 / 암부 ${r.shadowStops.toFixed(3)}스톱 (편차 ${Math.max(dm, ds).toExponential(1)})`
    );
    // 경고 문구에 숫자가 실제로 들어 있어야 한다. 문구와 값이 갈라지면
    // 사용자는 틀린 수를 보고 판단하게 된다.
    check(
      `${name} 경고 문구에 그 수가 실려 있다`,
      r.message.includes(r.midGrayStops.toFixed(2)) && r.message.includes(r.shadowStops.toFixed(2))
    );
    // 암부가 기준 그레이보다 **더** 어긋나야 한다 — 그게 이 경고의 핵심이다
    // (상수 오프셋이면 노광 슬라이더로 상쇄되지만, 휘면 못 되돌린다).
    check(`${name}는 암부가 기준보다 더 어긋난다`, r.shadowStops > r.midGrayStops + 0.1);
  }
}

console.log(pass ? "\n✅ 전 항목 통과" : "\n❌ 실패 항목 있음");
process.exit(pass ? 0 : 1);
