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
          // 32768을 넘는 것은 정상이므로 부호로 해석하면 안 된다. 값이 [0,1]
          // 안에 있다는 것을 알고 있으므로 mod 1로 대표값을 고른다.
          const s = bin.readUInt16LE(off + c * 2);
          const dec = ((s / 65536 + idx[c] / (n - 1)) % 1 + 1) % 1;
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

console.log(fails ? `\n정합성 실패 ${fails}건` : "\n정합성 통과 — 모든 산출 경로가 같은 색을 낸다");
process.exit(fails ? 1 : 0);
