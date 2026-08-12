#!/usr/bin/env node
/**
 * 산출 경로 정합성 검사.
 *
 * 색 하나가 네 갈래로 나간다 — 문서 적용(putPixels), `.cube`, ACR 프로파일(.xmp),
 * 패널 미리보기. 지금은 넷 다 `film.buildForParams` 하나를 통과하므로 갈라질 수
 * 없다. **이 검사는 그 사실이 계속 참인지 확인한다.**
 *
 * 누군가(사람이든 모델이든) 한 경로에만 변환을 끼워 넣으면 여기서 걸린다.
 * 기능을 추가할 때 "다른 경로도 고쳐야 하나?"를 기억에 의존하지 않게 하는 것이
 * 목적이다.
 *
 *   node tools/check-conformance.js
 */

const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const C = (p) => require(path.join(ROOT, "core", p));

const film = C("color/film");
const films = C("color/films");
const scanner = C("color/scanner");
const paper = C("color/paper");
const lut = C("color/lut");
const cube = C("io/cube");
const xmp = C("io/xmp");
const { defaultParams } = require(path.join(ROOT, "apps/engine/src/params"));

let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "  OK " : "FAIL "} ${name}${extra ? "  " + extra : ""}`);
};

/** .cube 텍스트에서 격자를 되읽는다. */
function parseCube(text) {
  const rows = [];
  let size = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("LUT_3D_SIZE")) size = Number(line.split(/\s+/)[1]);
    else if (/^[\d.\-]/.test(line)) rows.push(line.trim().split(/\s+/).map(Number));
  }
  return { size, rows };
}

/** .xmp 페이로드를 되읽는다 (Base85 → zlib → 잔차 → 값). */
const B85 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  ".-:+=^!/*?" + "`'|" + "()[]{}@%$#";
function parseXmp(text) {
  const payload = text.match(/crs:Table_\w+="([^"]+)"/)[1];
  const V = new Map([...B85].map((c, i) => [c, i]));
  const bytes = [];
  for (let i = 0; i < payload.length; i += 5) {
    const g = payload.slice(i, i + 5);
    let x = 0;
    for (let j = g.length - 1; j >= 0; j--) x = x * 85 + V.get(g[j]);
    x %= 4294967296;
    const n = g.length === 5 ? 4 : g.length - 1;
    for (let j = 0; j < n; j++) bytes.push(Math.floor(x / Math.pow(256, j)) & 0xff);
  }
  const raw = Buffer.from(bytes);
  const bin = zlib.inflateSync(raw.subarray(4));
  const N = bin.readUInt32LE(12);
  return { N, bin };
}

// 프로브: 원색·회색·피부·하늘 등 성격이 다른 지점을 고른다.
const PROBES = [
  [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.18, 0.18, 0.18],
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [0.75, 0.55, 0.45], [0.35, 0.55, 0.75], [0.9, 0.85, 0.3],
];

const params = defaultParams();
params.film.enabled = true;
params.film.id = "kodak-portra-400";
params.film.scanner = "frontier";
params.grading.enabled = true;
params.grading.toe = 25;
params.grading.selectiveColor.reds = { c: -6, m: 3, y: 8, k: 0 };
// 피부 의사 색역도 함께 건다 — 켜 두지 않으면 네 경로 중 하나만 고쳐도 검사가 통과한다.
params.grading.selectiveColor.skin = { c: 4, m: -5, y: 6, k: 0 };
params.grading.protectSkin = true;

console.log("색 경로 정합성 (필름 + 스캐너 + 그레이딩이 모두 켜진 상태)");

// ── 기준: 엔진이 직접 구운 LUT ──────────────────────────────────────
const N = 33;
const base = film.buildForParams(params, N);
const ref = PROBES.map((p) => {
  const out = [0, 0, 0];
  lut.sample(base, N, p[0], p[1], p[2], out);
  return out.slice();
});

// ── 1. .cube 경로 ────────────────────────────────────────────────────
{
  const { size, rows } = parseCube(cube.build(params, { size: N, space: "prophoto" }));
  const flat = new Float32Array(size * size * size * 3);
  rows.forEach((r, i) => { flat[i * 3] = r[0]; flat[i * 3 + 1] = r[1]; flat[i * 3 + 2] = r[2]; });
  let max = 0;
  PROBES.forEach((p, i) => {
    const out = [0, 0, 0];
    lut.sample(flat, size, p[0], p[1], p[2], out);
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(out[c] - ref[i][c]));
  });
  ok(".cube === 엔진", max < 2e-6, `최대차 ${max.toExponential(2)}`);
}

// ── 2. .xmp 프로파일 경로 ────────────────────────────────────────────
//
// 32³ 격자에 잔차 인코딩이라 되읽어 복원한 뒤 비교한다. 엔진을 같은 32³으로
// 다시 구워 대조해야 리샘플 차이가 섞이지 않는다.
{
  const { N: n, bin } = parseXmp(xmp.buildXmp(params, { space: "prophoto" }));
  const engine32 = film.buildForParams(params, n);
  let max = 0;
  for (let r = 0; r < n; r++) {
    for (let g = 0; g < n; g++) {
      for (let b = 0; b < n; b++) {
        const off = 16 + ((r * n + g) * n + b) * 6;
        const idx = [r, g, b];
        for (let c = 0; c < 3; c++) {
          // 잔차는 **부호 있는 수가 아니라 modulo 1 값**이다. 큰 양수 잔차가
          // 32768을 넘는 것은 정상이므로 부호로 해석하면 안 된다.
          //
          // 다만 `mod 1`을 무조건 걸어도 안 된다. `v = 1.0`이고 i가 마지막 격자면
          // 잔차가 0이 되는데, mod를 걸면 0.0으로 접혀 **정확히 1.0만큼 어긋난다.**
          // 합이 [0,2)에 들어오므로 **1을 넘을 때만** 빼면 모호함이 없다.
          const s = bin.readUInt16LE(off + c * 2);
          let dec = s / 65536 + idx[c] / (n - 1);
          if (dec > 1) dec -= 1; // 음의 잔차가 감긴 경우
          const want = Math.max(0, Math.min(1, engine32[((b * n + g) * n + r) * 3 + c]));
          max = Math.max(max, Math.abs(dec - want));
        }
      }
    }
  }
  ok(".xmp === 엔진", max < 2e-5, `최대차 ${max.toExponential(2)} (전 격자점 ${n}³)`);
}

// ── 3. putPixels 경로 ────────────────────────────────────────────────
//
// applyLut은 호스트 API를 부르므로 여기서 직접 못 돌린다. 대신 그것이 쓰는
// 계산부(lut.applyToBuffer)를 같은 입력으로 통과시켜 대조한다.
{
  const MAX16 = lut.PS_MAX_16;
  const src = new Uint16Array(PROBES.length * 3);
  PROBES.forEach((p, i) => {
    for (let c = 0; c < 3; c++) src[i * 3 + c] = Math.round(p[c] * MAX16);
  });
  const out = lut.applyToBuffer(src, 3, PROBES.length, base, N);
  let max = 0;
  PROBES.forEach((p, i) => {
    for (let c = 0; c < 3; c++) {
      max = Math.max(max, Math.abs(out[i * 3 + c] / MAX16 - ref[i][c]));
    }
  });
  // 16bit 양자화 **한 스텝**(1/32768 = 3.05e-5)이 허용 오차다.
  //
  // 예전에는 이 자리가 6e-5, 즉 두 스텝이었다. `applyToBuffer`가 정수 배열에 float을
  // 그냥 대입해 **버림**하고 있었고(채널당 평균 −0.5LSB) 그래서 한 스텝으로는 통과할
  // 수 없었다. 반올림으로 고친 뒤 실측 2.48e-5라 한 스텝 안에 들어온다.
  // 버림으로 되돌리면 5.15e-5가 되어 여기서 걸린다 — 음성 테스트로 확인했다.
  ok("putPixels === 엔진", max < 1 / MAX16, `최대차 ${max.toExponential(2)} (한 스텝 ${(1 / MAX16).toExponential(2)})`);
}

// ── 4. 산출 경로가 정말 하나의 함수를 통과하는가 ─────────────────────
//
// 위 셋이 통과해도, 누군가 각 경로에 같은 변환을 복붙해 두면 통과한다.
// 그래서 소스에서 "엔진을 부르는 곳이 하나뿐인지"도 본다.
{
  const fs = require("fs");
  const readers = [];
  for (const f of ["core/io/cube.js", "core/io/xmp.js", "apps/engine/src/pipeline.js", "apps/engine/src/preview.js"]) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (/film\.buildForParams\(/.test(s)) readers.push(f);
  }
  ok("네 경로 모두 buildForParams를 통과", readers.length === 4, readers.join(", "));
}

// ── 5. 필름 전 종 × 스캐너 전 종에서 .cube와 엔진이 일치 ─────────────
{
  let worst = 0, where = null;
  for (const f of films.all()) {
    for (const sc of scanner.all()) {
      for (const pp of paper.all()) {
      const p = JSON.parse(JSON.stringify(params));
      p.film.id = f.id;
      p.film.scanner = sc.id;
      p.film.paper = pp.id;
      const eng = film.buildForParams(p, 33);
      const { size, rows } = parseCube(cube.build(p, { size: 33, space: "prophoto" }));
      for (let i = 0; i < rows.length; i++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(rows[i][c] - eng[i * 3 + c]);
          if (d > worst) { worst = d; where = `${f.id}/${sc.id}/${pp.id}`; }
        }
      }
      if (size !== 33) { worst = 1; where = "격자 크기 불일치"; }
      }
    }
  }
  ok(`필름 ${films.all().length} × 스캐너 ${scanner.all().length} × 인화지 ${paper.all().length} 전 조합`,
    worst < 2e-6, `최대차 ${worst.toExponential(2)}${where ? " @ " + where : ""}`);
}

// ── 5a. 입력 전달함수(리니어 현상본) ──────────────────────────────────
//
// `params.film.input`은 화면·적용·내보내기 **전부**에 걸린다. 네 경로가 갈라지면
// 미리보기와 적용이 다른 색을 낸다.
{
  const inputs = C("color/inputs");
  const N = 33;

  // 기본값은 지금까지와 비트 동일해야 한다
  const base = film.buildForParams(params, N);
  const p0 = JSON.parse(JSON.stringify(params));
  p0.film.input = "prophoto";
  const same0 = film.buildForParams(p0, N);
  let d0 = 0;
  for (let i = 0; i < base.length; i++) d0 = Math.max(d0, Math.abs(base[i] - same0[i]));
  ok("input 기본값이 기존 동작과 비트 동일", d0 === 0, `최대차 ${d0}`);

  // 전 입력 전달함수에서 .cube와 엔진이 일치 — 비대칭 LUT도 같은 수를 내야 한다
  let worst = 0, where = null;
  for (const inp of inputs.applyable()) {
    const p = JSON.parse(JSON.stringify(params));
    p.film.input = inp.id;
    p.film.paper = "kodak-endura-premier";
    const eng = film.buildForParams(p, N);
    const { rows } = parseCube(cube.build(p, { size: N, space: "prophoto" }));
    for (let i = 0; i < rows.length; i++) {
      for (let c = 0; c < 3; c++) {
        const dd = Math.abs(rows[i][c] - eng[i * 3 + c]);
        if (dd > worst) { worst = dd; where = inp.id; }
      }
    }
  }
  ok(`입력 ${inputs.applyable().length}종 × .cube === 엔진`, worst < 2e-6,
    `최대차 ${worst.toExponential(2)}${where ? " @ " + where : ""}`);

  // **기준 그레이가 어느 입력에서도 같은 색을 낸다.** 헤드룸이 달라도 18% 그레이는
  // 18% 그레이다 — 여기가 어긋나면 도구가 놓은 자리와 엔진이 읽는 자리가 다른 것이고,
  // 그건 통째로 노출이 밀렸다는 뜻이다.
  const clean = JSON.parse(JSON.stringify(params));
  clean.film.scanner = "none";
  clean.film.paper = "kodak-endura-premier";
  clean.grading.enabled = false;
  //
  // ⚠️ **최근접 격자점으로 재면 안 된다.** 기준 그레이의 인코딩값이 입력마다 다른데
  // (0.386 / 0.214 / 0.146 / 0.099) 격자에 정확히 안 떨어진다. 게다가 저코드 쪽일수록
  // 인코딩 축이 압축돼 같은 반올림이 더 큰 노광 오차가 된다 — linear-h6에서 0.14스톱,
  // 8bit로 5계단이다. 처음에 그렇게 쟀다가 편차 8.1/255로 허위 실패했다.
  // **보간 조회**로 정확한 좌표를 본다.
  const mids = [];
  const tmp = [0, 0, 0];
  for (const inp of inputs.applyable()) {
    const p = JSON.parse(JSON.stringify(clean));
    p.film.input = inp.id;
    const t = film.buildForParams(p, 65);
    const v = inp.midGrayEncoded;
    lut.sample(t, 65, v, v, v, tmp);
    mids.push([inp.id, tmp[0], tmp[1], tmp[2]]);
  }
  let spread = 0;
  for (let c = 1; c <= 3; c++) {
    const vals = mids.map((m) => m[c]);
    spread = Math.max(spread, Math.max(...vals) - Math.min(...vals));
  }
  ok("입력이 달라도 기준 그레이가 같은 색", spread < 0.006,
    `채널별 최대 편차 ${(spread * 255).toFixed(2)}/255  ` +
    mids.map((m) => `${m[0]}=${(m[1] * 255).toFixed(1)}`).join(" "));
}

// ── 5b. S-Log3 입력 LUT ───────────────────────────────────────────────
//
// 비대칭 LUT(로그 입력 → 표시 출력)이라 "적용과 같은 색"이 성립하지 않는다.
// 대신 **로그 소스에서 지켜야 할 성질**을 본다.
{
  const cs = C("color/colorspace");
  const N = 33, d = N - 1;
  const parse = (p, o) =>
    cube.build(p, o).split("\n").filter((l) => /^[\d.-]/.test(l))
      .map((l) => l.trim().split(/\s+/).map(Number));

  // 옵션을 붙여도 기존 경로가 안 움직이는가 — 이건 **위쪽 무거운 params**로 본다.
  // 스캐너·그레이딩까지 켜진 상태에서 불변이어야 진짜 불변이다.
  const a = parse(params, { size: N, space: "prophoto" });
  const b = parse(params, { size: N, space: "prophoto", input: "engine" });
  let same = 0;
  for (let i = 0; i < a.length; i++) for (let c = 0; c < 3; c++) same = Math.max(same, Math.abs(a[i][c] - b[i][c]));
  ok("input 옵션이 기존 .cube를 바꾸지 않는다", same === 0, `최대차 ${same}`);

  // 아래 성질 검사는 **중립 파라미터**로 한다. 위쪽 params는 frontier 스캐너(시안
  // 섀도 + 골든 스킨 틴트)와 강한 그레이딩이 켜져 있어 회색이 **의도적으로** 중성이
  // 아니다. 그것으로 재면 S-Log3 경로의 결함과 스캐너 틴트를 구분할 수 없다
  // (실제로 처음 이 검사를 그렇게 짰다가 채널폭 0.045로 허위 실패했다).
  const clean = JSON.parse(JSON.stringify(params));
  clean.film.scanner = "none";
  clean.film.paper = "kodak-endura-premier";
  clean.grading.enabled = false;

  const R = parse(clean, { size: N, space: "acr", input: "slog3" });
  const at = (v) => { const i = Math.round(v * d); return R[(i * N + i) * N + i]; };

  // 1) 18% 그레이(코드 420/1023)가 중성으로 나와야 한다. 원색 행렬이 틀리면
  //    여기가 먼저 물든다 — 행합이 1이 아닌 행렬을 쓰면 바로 잡힌다.
  const g = at(420 / 1023);
  const spread = Math.max(...g) - Math.min(...g);
  ok("S-Log3 18% 그레이가 중성", spread < 0.005, `채널폭 ${spread.toFixed(4)} @ ${g.map((x) => x.toFixed(4)).join(",")}`);

  // 2) 그레이 축 단조. 로그 디코드나 hWhite가 어긋나면 뒤집힌다.
  let rev = 0;
  for (let i = 1; i <= d; i++) {
    const lo = R[((i - 1) * N + (i - 1)) * N + (i - 1)], hi = R[(i * N + i) * N + i];
    for (let c = 0; c < 3; c++) if (hi[c] < lo[c] - 1e-9) rev++;
  }
  ok("S-Log3 그레이 축이 단조", rev === 0, `역전 ${rev}회`);

  // 3) **선형 1.0 위의 하이라이트가 살아 있는가.** 이게 이 구현의 존재 이유다.
  //    이미 구운 ProPhoto LUT을 재격자하는 방식이면 코드 0.596 위가 전부 같은
  //    값으로 뭉개진다(엔진 LUT의 정의역이 선형 0~1이라 좌표가 잘린다).
  //    여기서 그 naive 방식을 실제로 계산해 죽는 것을 보이고, 우리 것과 대조한다.
  const above = [0.596, 0.7, 0.8, 0.9, 1.0].map((v) => at(v)[1]);
  const rising = above.every((x, i) => i === 0 || x > above[i - 1]);
  ok("S-Log3 선형 1.0 위 하이라이트가 살아 있다", rising,
    above.map((x) => x.toFixed(4)).join(" → "));

  // 재격자 방식이면 조회 좌표가 전부 격자 끝(1.0)에 붙어 같은 값을 낸다.
  // 우리 쪽은 같은 구간에서 0.13 넘게 오른다 — 그 대비가 이 구현의 근거다.
  const naiveCoord = [0.596, 0.7, 0.8, 0.9, 1.0]
    .map((v) => Math.min(1, Math.pow(Math.max(cs.slog3Decode(v), 0), 1 / 1.8)));
  const naiveSpan = Math.max(...naiveCoord) - Math.min(...naiveCoord);
  const oursSpan = Math.max(...above) - Math.min(...above);
  ok("(대조) 재격자 방식이었으면 그 구간이 죽는다", naiveSpan < 1e-3 && oursSpan > 0.05,
    `재격자 조회 좌표 폭 ${naiveSpan.toExponential(1)} (전부 격자 끝) vs 실제 출력 폭 ${oursSpan.toFixed(3)}`);

  // 4) 코드 범위를 얼마나 살렸는지 수치로. 재격자였다면 잘렸을 비율이다.
  const codeAtLinear1 = cs.slog3Encode(1);
  ok("살린 코드 범위", codeAtLinear1 > 0.5 && codeAtLinear1 < 0.7,
    `선형 1.0 = 코드 ${codeAtLinear1.toFixed(3)} → 재격자였다면 코드의 ${((1 - codeAtLinear1) * 100).toFixed(0)}%가 흰색으로 뭉갬`);
}

// ── 5c. .xmp는 패널의 입력 소스를 무시하고 항상 ProPhoto다 ──────────────
//
// Lightroom은 decode-raw.py가 뭘 했는지 알 방법이 없다 — 패널을 「리니어 +N스톱」
// 으로 켜둔 채 "Lightroom 프로파일" 내보내기를 누르면(엔진에 리니어 TIFF를 먹이던
// 중이면 흔한 상태다) 나가는 프로파일이 입력을 N스톱 밀린 것으로 가정하게 되고,
// 그걸 Lightroom의 정상 렌더링에 걸면 전부 하이라이트 숄더로 밀려 채도가 무너진다
// (실측: 18% 그레이가 그 상태에서 +2.5스톱으로 읽혀 chroma가 절반 아래로 떨어짐 —
// 2026-08-13 실사용 중 발견). `xmp.buildXmp`가 `input: "prophoto"`를 강제해야 한다.
{
  const withLinear = JSON.parse(JSON.stringify(params));
  withLinear.film.input = "linear-h5";
  const a = xmp.buildXmp(params, { space: "prophoto" });
  const b = xmp.buildXmp(withLinear, { space: "prophoto" });
  ok(".xmp는 params.film.input을 무시한다(항상 ProPhoto)", a === b,
    a === b ? "동일" : "입력 소스에 따라 .xmp가 달라짐 — Lightroom에서 못 쓴다");
}

// ── 5d. 닷지·번 (실험적) ─────────────────────────────────────────────
//
// `opts.dodgeBurn`. 필름의 H→D 응답은 안 건드리고 인화 직전에 luma(색 보존)만
// 압축·대비 복원한다 — MDR03671(실사진, 5.8스톱 폭)에서 채도가 무너지던 것을
// 고친 자리(2026-08-13). 여기서는 세 가지만 본다: (1) 꺼져 있으면(기본) 있기
// 전과 완전히 같다, (2) 켜면 실제로 결과가 달라진다, (3) 극단 노출에서 채도가
// **개선**된다(방향이 반대로 걸리면 조용히 상황을 악화시키는 것이라 가장 위험).
{
  const N = 33;
  const filmDef = films.byId("kodak-portra-800");
  const base = { size: N, exposure: 0, paper: "kodak-endura-premier", input: "prophoto" };

  const off = film.buildLut(filmDef, base);
  const offExplicit = film.buildLut(filmDef, { ...base, dodgeBurn: undefined });
  let maxDiffOff = 0;
  for (let i = 0; i < off.length; i++) maxDiffOff = Math.max(maxDiffOff, Math.abs(off[i] - offExplicit[i]));
  ok("닷지·번 꺼짐 === opts.dodgeBurn 없음", maxDiffOff === 0, `최대차 ${maxDiffOff}`);

  const on = film.buildLut(filmDef, { ...base, dodgeBurn: { limit: 0.4, contrast: 0.6 } });
  let maxDiffOn = 0;
  for (let i = 0; i < off.length; i++) maxDiffOn = Math.max(maxDiffOn, Math.abs(off[i] - on[i]));
  ok("닷지·번 켜면 결과가 달라진다", maxDiffOn > 0.01, `최대차 ${maxDiffOn.toFixed(4)}`);

  // buildForParams 경로도 확인 — params.film.dodgeBurn.enabled로 걸리는지.
  const p = JSON.parse(JSON.stringify(params));
  p.film.id = "kodak-portra-800";
  p.film.paper = "kodak-endura-premier";
  p.film.input = "prophoto";
  p.grading.enabled = false;
  const viaParamsOff = film.buildForParams(p, N);
  p.film.dodgeBurn = { enabled: true, limit: 0.4, contrast: 0.6 };
  const viaParamsOn = film.buildForParams(p, N);
  let maxDiffParams = 0;
  for (let i = 0; i < viaParamsOff.length; i++) maxDiffParams = Math.max(maxDiffParams, Math.abs(viaParamsOff[i] - viaParamsOn[i]));
  ok("buildForParams가 film.dodgeBurn.enabled를 반영한다", maxDiffParams > 0.01, `최대차 ${maxDiffParams.toFixed(4)}`);

  // 극단 노출(과다·과소) 채도가 압축 켰을 때 개선되는지 — 방향 검사.
  // ⚠️ max−min(chroma)은 **국소적으로 선형인 인화 구간**에서는 균일한 덧셈
  // 시프트에 불변이라(세 채널에 같은 상수를 더하면 max−min이 안 변한다) 아무
  // 점이나 고르면 조용히 무의미한 검사가 된다. MDR03671 실사진에서 실제로
  // 개선을 확인한 채널별 스톱(2026-08-13 렌더)을 그대로 쓴다 — 어깨/발끝
  // 깊숙한 곳이라 국소 선형 구간이 아니다.
  function chroma(out) { return Math.max(...out) - Math.min(...out); }
  function sample(table, v) { const o = [0, 0, 0]; lut.sample(table, N, v[0], v[1], v[2], o); return o; }
  function vFromStops(stops) {
    return stops.map((s) => Math.pow(ANCHOR * Math.pow(2, s), 1 / 1.8));
  }
  const ANCHOR = 0.18;
  const highStops = [2.51, 2.29, 2.17]; // 흰 블라우스 — 어깨 깊숙이
  const lowStops = [-2.14, -2.67, -3.17]; // 어두운 나무 — 발끝 깊숙이
  const chromaHighOff = chroma(sample(off, vFromStops(highStops)));
  const chromaHighOn = chroma(sample(on, vFromStops(highStops)));
  const chromaLowOff = chroma(sample(off, vFromStops(lowStops)));
  const chromaLowOn = chroma(sample(on, vFromStops(lowStops)));
  ok("닷지·번 — 어깨(하이라이트) 채도가 개선된다", chromaHighOn > chromaHighOff,
    `${chromaHighOff.toFixed(4)} → ${chromaHighOn.toFixed(4)}`);
  ok("닷지·번 — 발끝(섀도) 채도가 개선된다", chromaLowOn > chromaLowOff,
    `${chromaLowOff.toFixed(4)} → ${chromaLowOn.toFixed(4)}`);
}

// ── 6. 그레이딩이 색역을 좁히지 않는가 ───────────────────────────────
//
// 이전 구현은 ProPhoto → sRGB → 그레이딩 → ProPhoto로 왕복하며 클램프해서
// **손대지 않은 색까지** sRGB 색역으로 잘라냈다(33³의 82.5%가 이동). 지금은
// 판정만 클램프한 대리색으로 하고 조정량을 선형광에 실어 옮긴다.
//
// 중립에 가까운 그레이딩을 켰을 때 색이 움직이면 그 회귀가 돌아온 것이다.
{
  const p = defaultParams();
  p.film.id = "kodak-ektar-100";
  p.film.scanner = "frontier"; // 채도가 높아 색역 밖이 많다
  const off = film.buildForParams(p, 33);

  const on = JSON.parse(JSON.stringify(p));
  on.grading.enabled = true;
  on.grading.selectiveColor.reds = { c: 0, m: 0, y: 0, k: 1e-9 }; // 켜기만 한다
  const table = film.buildForParams(on, 33);

  let moved = 0, max = 0;
  for (let i = 0; i < off.length; i++) {
    const d = Math.abs(table[i] - off[i]);
    if (d > 1 / 255) moved++;
    if (d > max) max = d;
  }
  ok("중립 그레이딩이 색을 옮기지 않는다", moved === 0 && max < 1e-4,
    `이동 ${moved} / ${off.length}, 최대 ${max.toExponential(2)}`);
}

// ── 7. 필름·그레이딩 on/off 전 조합에서 경로가 갈라지지 않는가 ───────
//
// 여기서 실제 버그가 났었다. `film.enabled`를 호출자마다 따로 검사해서,
// 미리보기는 그레이딩을 보여주는데 적용은 아무것도 하지 않고(최대 14/255 차이)
// 내보내기는 에러를 던졌다. 팔레트·컬러휠은 스캐너 단계를 빠뜨렸다.
//
// **6번까지의 검사는 필름이 켜진 상태만 봐서 이걸 놓쳤다.** 상태 조합을 도는 것이
// 이 검사의 핵심이다.
{
  const STATES = [
    ["필름ON  그레이딩ON", true, true, false],
    ["필름ON  그레이딩OFF", true, false, false],
    ["필름OFF 그레이딩ON", false, true, false],
    ["필름OFF 그레이딩ON(중립)", false, true, true],
    ["필름OFF 그레이딩OFF", false, false, false],
  ];
  const mk = (filmOn, gradOn, neutral) => {
    const p = defaultParams();
    p.film.enabled = filmOn;
    p.film.id = "kodak-portra-400";
    p.film.scanner = "frontier";
    p.grading.enabled = gradOn;
    if (gradOn && !neutral) {
      p.grading.toe = 25;
      p.grading.selectiveColor.reds = { c: -6, m: 3, y: 8, k: 0 };
    }
    return p;
  };

  let bad = [];
  for (const [name, fo, go, nu] of STATES) {
    const p = mk(fo, go, nu);
    const effect = film.hasEffect(p);
    const table = film.buildForParams(p, 17);

    // 효과가 없다고 판정했으면 LUT이 실제로 항등이어야 한다. 반대도 마찬가지다.
    const ident = lut.identity(17);
    let max = 0;
    for (let i = 0; i < table.length; i++) max = Math.max(max, Math.abs(table[i] - ident[i]));
    const isIdentity = max < 1e-6;
    if (effect === isIdentity) {
      bad.push(`${name}: hasEffect=${effect} 인데 LUT은 ${isIdentity ? "항등" : "항등 아님"}`);
    }

    // 내보내기는 효과가 있을 때만 성공해야 한다 (성공/실패가 판정과 일치)
    for (const [label, fn] of [
      [".cube", () => cube.build(p, { size: 33, space: "prophoto" })],
      [".xmp", () => xmp.buildXmp(p, { space: "prophoto" })],
    ]) {
      let okd = true;
      try { fn(); } catch (e) { okd = false; }
      if (okd !== effect) bad.push(`${name}: ${label} ${okd ? "성공" : "실패"} 인데 hasEffect=${effect}`);
    }
  }
  ok("필름·그레이딩 5개 상태에서 판정과 결과가 일치", bad.length === 0, bad.join(" / "));

  // 미리보기가 별도 경로를 쓰지 않는가 — 소스에서 확인한다.
  // 값 비교로는 못 잡는다. 미리보기는 호스트 API가 필요해 여기서 못 돌린다.
  const fs = require("fs");
  const pv = fs.readFileSync(path.join(ROOT, "apps/engine/src/preview.js"), "utf8");
  ok("미리보기가 simulate를 직접 부르지 않는다", !/simulate\.applyGrading\(/.test(pv),
    "그레이딩을 따로 계산하면 적용 결과와 갈라진다");

  const mn = fs.readFileSync(path.join(ROOT, "apps/engine/src/main.js"), "utf8");
  ok("팔레트·컬러휠이 합성을 직접 조합하지 않는다",
    !/film\.buildLut\(/.test(mn) && !/film\.bakeGrading\(/.test(mn),
    "buildForParams를 쓰지 않으면 스캐너 단계가 빠진다");
}

console.log(fails ? `\n정합성 실패 ${fails}건` : "\n정합성 통과 — 모든 산출 경로가 같은 색을 낸다");
process.exit(fails ? 1 : 0);
