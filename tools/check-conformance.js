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
  // 16bit 양자화 한 스텝(1/32768 = 3.05e-5)이 허용 오차다
  ok("putPixels === 엔진", max < 6e-5, `최대차 ${max.toExponential(2)}`);
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
      const p = JSON.parse(JSON.stringify(params));
      p.film.id = f.id;
      p.film.scanner = sc.id;
      const eng = film.buildForParams(p, 33);
      const { size, rows } = parseCube(cube.build(p, { size: 33, space: "prophoto" }));
      for (let i = 0; i < rows.length; i++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(rows[i][c] - eng[i * 3 + c]);
          if (d > worst) { worst = d; where = `${f.id}/${sc.id}`; }
        }
      }
      if (size !== 33) { worst = 1; where = "격자 크기 불일치"; }
    }
  }
  ok(`필름 ${films.all().length} × 스캐너 ${scanner.all().length} 전 조합`, worst < 2e-6,
    `최대차 ${worst.toExponential(2)}${where ? " @ " + where : ""}`);
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
