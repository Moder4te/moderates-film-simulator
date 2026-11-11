#!/usr/bin/env node
/**
 * 독립 실행형(apps/studio) 검사 — Photoshop 없이 도는 경로의 불변식.
 *
 *   node tools/check-studio.js
 *
 * 여기서 지키는 것은 넷이다.
 *
 *   1. 파일   TIFF를 제대로 읽고 쓰는가. 색이 틀린 채 열리면 그 뒤가 전부 무의미하다
 *   2. 공간   작업 공간을 드나드는 것이 값을 바꾸지 않는가
 *   3. 영역   **어떻게 잘라 굽든 결과가 같은가** — 이 파이프라인의 설계 전제다.
 *             깨지면 띠 경계에 줄이 가거나 1:1 보기와 내보낸 파일이 달라진다
 *   4. 색     엔진 색이 다른 네 산출 경로와 같은가(다섯 번째 경로)
 *
 * 브라우저가 필요한 것(캔버스·워커·화면)은 여기서 못 본다. 세션은 환경을 주입받게
 * 돼 있어 **가짜 환경**으로 끝까지 돌린다 — 파일 열기 → 미리보기 → 내보내기.
 */

const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const R = (p) => require(path.join(ROOT, p));

const tiff = R("core/io/tiff");
const icc = R("core/io/icc");
const working = R("core/render/working");
const pipeline = R("core/render/pipeline");
const film = R("core/color/film");
const lut = R("core/color/lut");
const params = R("apps/studio/src/params");
const { createSession } = R("apps/studio/src/session");

let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "  OK " : "FAIL "} ${name}${extra ? "  " + extra : ""}`);
};
const same = (a, b) => {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 시험 이미지 — 그라데이션 + 포화색 띠 + 밝은 원(할레이션 소스) + 미세 무늬. */
function testImage(w, h) {
  const data = new Uint16Array(w * h * 3);
  const rnd = rng(7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const u = x / (w - 1), v = y / (h - 1);
      let r = u, g = 0.5 * (u + v), b = v;
      if (y % 9 < 2) { r = u; g = 0.05; b = 1 - u; } // 포화색 띠
      const dx = x - w * 0.7, dy = y - h * 0.35;
      if (dx * dx + dy * dy < (h * 0.12) ** 2) { r = g = b = 1; } // 광원
      if ((x + y) % 5 === 0) { r *= 0.8; g *= 0.8; b *= 0.8; } // 1px 무늬 — 디퓨전이 옮길 것
      const n = (rnd() - 0.5) * 0.01;
      data[o] = Math.max(0, Math.min(65535, (r + n) * 65535));
      data[o + 1] = Math.max(0, Math.min(65535, (g + n) * 65535));
      data[o + 2] = Math.max(0, Math.min(65535, (b + n) * 65535));
    }
  }
  return { width: w, height: h, data };
}

/** 검사용 TIFF LZW 인코더(MSB 우선, 조기 폭 변경). 디코더와 **따로** 짠 구현이다. */
function lzwEncode(src) {
  const out = [];
  let acc = 0, nbits = 0;
  const emit = (code, width) => {
    acc = (acc << width) | code; nbits += width;
    while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 255); nbits -= 8; }
    acc &= (1 << nbits) - 1;
  };
  let dict = new Map(), next = 258, width = 9;
  emit(256, width);
  let cur = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (cur === -1) { cur = c; continue; }
    const key = cur * 256 + c;
    if (dict.has(key)) { cur = dict.get(key); continue; }
    emit(cur, width);
    dict.set(key, next++);
    // 인코더는 디코더보다 사전이 한 칸 앞선다 — 그래서 폭을 바꾸는 자리가 512·1024·2048이다
    // (디코더는 511·1023·2047. libtiff의 두 루프가 그렇게 맞물린다)
    if (next === 512) width = 10; else if (next === 1024) width = 11; else if (next === 2048) width = 12;
    if (next === 4094) { emit(256, width); dict = new Map(); next = 258; width = 9; }
    cur = c;
  }
  if (cur !== -1) emit(cur, width);
  emit(257, width);
  if (nbits) out.push((acc << (8 - nbits)) & 255);
  return Uint8Array.from(out);
}

/** 임의 구성의 TIFF를 손으로 짠다(바이트 순서·스트립·타일·압축·예측자). */
function makeTiff(img8or16, w, h, bits, o) {
  const le = o.le !== false, samples = o.samples || 3, bps = bits / 8;
  const blockW = o.tile ? o.tile[0] : w, blockH = o.tile ? o.tile[1] : (o.rows || h);
  const across = o.tile ? Math.ceil(w / blockW) : 1, down = Math.ceil(h / blockH);
  const blocks = [];
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const rows = o.tile ? blockH : Math.min(blockH, h - by * blockH);
      const raw = new Uint8Array(blockW * rows * samples * bps);
      for (let y = 0; y < rows; y++) {
        const prev = new Array(samples).fill(0);
        for (let x = 0; x < blockW; x++) {
          const sx = Math.min(w - 1, bx * blockW + x), sy = Math.min(h - 1, by * blockH + y);
          for (let s = 0; s < samples; s++) {
            let v = s < 3 ? img8or16[(sy * w + sx) * 3 + s] : (bits === 16 ? 65535 : 255);
            const actual = v;
            if (o.predictor) { v = (v - prev[s]) & (bits === 16 ? 65535 : 255); prev[s] = actual; }
            const p = ((y * blockW + x) * samples + s) * bps;
            if (bps === 1) raw[p] = v;
            else if (le) { raw[p] = v & 255; raw[p + 1] = v >> 8; }
            else { raw[p] = v >> 8; raw[p + 1] = v & 255; }
          }
        }
      }
      blocks.push(o.compression === 5 ? lzwEncode(raw) : o.compression === 8 ? new Uint8Array(zlib.deflateSync(raw)) : raw);
    }
  }
  const tags = [
    [256, 4, [w]], [257, 4, [h]], [258, 3, new Array(samples).fill(bits)],
    [259, 3, [o.compression || 1]], [262, 3, [2]], [277, 3, [samples]], [284, 3, [1]],
  ];
  if (o.predictor) tags.push([317, 3, [2]]);
  if (samples > 3) tags.push([338, 3, [2]]);
  if (o.icc) tags.push([34675, 7, Array.from(o.icc)]);
  const offTag = o.tile ? 324 : 273, cntTag = o.tile ? 325 : 279;
  if (o.tile) tags.push([322, 4, [blockW]], [323, 4, [blockH]]);
  else tags.push([278, 4, [blockH]]);
  tags.push([offTag, 4, blocks.map(() => 0)], [cntTag, 4, blocks.map((b) => b.length)]);
  tags.sort((a, b) => a[0] - b[0]);

  const size = { 3: 2, 4: 4, 7: 1 };
  let at = 8 + 2 + tags.length * 12 + 4;
  for (const t of tags) { const n = size[t[1]] * t[2].length; if (n > 4) { t.off = at; at += n + (n & 1); } }
  const offsets = [];
  for (const b of blocks) { offsets.push(at); at += b.length; }
  tags.find((t) => t[0] === offTag)[2] = offsets;

  const buf = new Uint8Array(at), dv = new DataView(buf.buffer);
  buf[0] = buf[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le); dv.setUint32(4, 8, le); dv.setUint16(8, tags.length, le);
  const put = (p, type, vals) => vals.forEach((v, k) => {
    if (type === 3) dv.setUint16(p + k * 2, v, le); else if (type === 4) dv.setUint32(p + k * 4, v, le); else buf[p + k] = v;
  });
  tags.forEach((t, i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, t[0], le); dv.setUint16(e + 2, t[1], le); dv.setUint32(e + 4, t[2].length, le);
    if (t.off != null) { dv.setUint32(e + 8, t.off, le); put(t.off, t[1], t[2]); } else put(e + 8, t[1], t[2]);
  });
  blocks.forEach((b, i) => buf.set(b, offsets[i]));
  return buf;
}

// 모든 마감 단계가 켜진 파라미터 — 영역 검사는 이걸로 한다
function fullParams(edit) {
  const p = params.defaultParams();
  p.film.paper = "kodak-endura-premier";
  p.tone.contrast = 12; p.tone.saturation = 15; p.tone.temp = 10; p.tone.exposure = 0.2;
  p.halation.threshold = 150; p.halation.strength = 60; p.halation.radius = 4;
  p.grain.iso = 1600; p.grain.midtone = 60; p.grain.shadow = 40; p.grain.highlight = 30;
  p.medium.reference = "custom"; p.medium.customLongEdge = 6000; // 입자 6.8px — 변위·격자 완화가 실제로 돈다
  if (edit) edit(p);
  return p;
}

function renderWhole(src, p) {
  const pl = pipeline.plan(p, src, src);
  const halo = pipeline.haloField(src, pl);
  return { pl, halo, buf: pipeline.renderRegion(src, pl, { x: 0, y: 0, w: src.width, h: src.height }, halo) };
}

(async () => {
  // ── 1. 파일 ─────────────────────────────────────────────────────────────
  console.log("TIFF · ICC");
  {
    const w = 61, h = 47;
    const img = testImage(w, h).data;
    const img8 = Uint8Array.from(img, (v) => v >> 8);
    const inflate = (b) => new Uint8Array(zlib.inflateSync(b));
    const cases = [
      ["무압축 16bit", img, 16, {}],
      ["무압축 16bit 빅엔디언", img, 16, { le: false }],
      ["LZW 8bit", img8, 8, { compression: 5 }],
      ["LZW 16bit + 예측자", img, 16, { compression: 5, predictor: true }],
      ["LZW 16bit 빅엔디언 + 예측자", img, 16, { compression: 5, predictor: true, le: false }],
      ["ZIP 16bit + 예측자, 스트립 5줄", img, 16, { compression: 8, predictor: true, rows: 5 }],
      ["타일 16×16 LZW + 예측자", img, 16, { compression: 5, predictor: true, tile: [16, 16] }],
      ["알파 포함 4채널", img, 16, { samples: 4, compression: 5 }],
    ];
    const bad = [];
    for (const [name, data, bits, o] of cases) {
      const t = await tiff.decode(makeTiff(data, w, h, bits, o), { inflate });
      const n = t.width === w && t.height === h && t.bits === bits ? same(t.data, data) : -1;
      if (n !== 0) bad.push(`${name}: ${n < 0 ? "크기·심도 불일치" : n + "개 다름"}`);
    }
    ok(`TIFF 읽기 ${cases.length}가지 구성`, bad.length === 0, bad.join(" / "));

    // 사전이 여러 번 차서 비워지는 길이 — 짧은 파일로는 그 분기를 안 탄다
    const noisy = new Uint8Array(300000);
    const rnd = rng(3);
    for (let i = 0; i < noisy.length; i++) noisy[i] = i % 7 === 0 ? rnd() * 256 : (i >> 3) & 255;
    ok("LZW — 사전이 가득 차 비워지는 길이에서도 맞다", same(tiff.lzwDecode(lzwEncode(noisy), noisy.length), noisy) === 0);

    const profile = icc.prophoto();
    const round = await tiff.decode(tiff.encode({ width: w, height: h, bits: 16, icc: profile }, img));
    ok("TIFF 쓰기 → 읽기 왕복(16bit)", same(round.data, img) === 0);
    ok("  └ ProPhoto ICC가 실리고 이름으로 읽힌다", icc.classify(icc.describe(round.icc)) === "prophoto",
      `${profile.length}바이트 "${icc.describe(round.icc)}"`);

    const refusals = [];
    for (const [name, bytes] of [
      ["BigTIFF", Uint8Array.from([0x49, 0x49, 43, 0, 8, 0, 0, 0])],
      ["32bit", (() => { const b = makeTiff(img, w, h, 16, {}); new DataView(b.buffer).setUint16(10 + 2 * 12 + 8, 0, true); return b; })()],
    ]) {
      try { await tiff.decode(bytes); refusals.push(name); } catch (e) { if (!e.unsupported) refusals.push(name + "(이유 없이 죽음)"); }
    }
    ok("못 읽는 형식은 이유를 적어 거부한다", refusals.length === 0, refusals.join(" / "));
  }

  // ── 2. 작업 공간 ────────────────────────────────────────────────────────
  console.log("\n작업 공간");
  {
    // sRGB 8bit → 작업 공간 → sRGB 8bit. 아무것도 안 했으면 원본이 그대로 나와야 한다
    const n = 256 * 3 + 40000;
    const rgba = new Uint8ClampedArray(n * 4);
    const rnd = rng(1);
    for (let p = 0; p < n; p++) {
      const g = p < 256, o = p * 4;
      rgba[o] = g ? p : rnd() * 256; rgba[o + 1] = g ? p : rnd() * 256; rgba[o + 2] = g ? p : rnd() * 256; rgba[o + 3] = 255;
    }
    const w16 = working.toWorking(rgba, 4, n, "srgb");
    const f = new Float32Array(n * 3);
    for (let i = 0; i < f.length; i++) f[i] = w16[i] / 65535;
    const back = working.toSRGB8(f, n, 1, 0, 0, n, new Uint8ClampedArray(n * 4), false);
    // 완전한 항등은 아니다 — 16bit ProPhoto 양자화가 sRGB 색역 **경계**(한 채널이 0)에서
    // 행렬의 큰 계수를 거쳐 1레벨로 올라오는 색이 드물게 있다(52만 색 중 1개 수준).
    // Photoshop의 색공간 왕복도 같은 한계를 갖는다. 불변식은 "≤1레벨, 0.01% 미만".
    const off = same(back, rgba), worst = maxDiff(back, rgba);
    let grayOff = 0;
    for (let i = 0; i < 256 * 4; i++) if (back[i] !== rgba[i]) grayOff++;
    ok("sRGB 8bit → 작업 공간 → sRGB 8bit 가 원본과 같다", grayOff === 0 && worst <= 1 && off / n < 1e-4,
      `${n}색 중 ${off}개가 ${worst}레벨 차(무채색 256단은 전부 일치)`);

    // littlecms가 같은 ICC로 낸 값(ProPhoto 8bit 128·98 회색 → sRGB 146·117)
    const gray = Float32Array.from([128 / 255, 128 / 255, 128 / 255, 98 / 255, 98 / 255, 98 / 255]);
    const g8 = working.toSRGB8(gray, 2, 1, 0, 0, 2, new Uint8ClampedArray(8), false);
    ok("ProPhoto → sRGB 가 색 관리 엔진(littlecms)과 같다", g8[0] === 146 && g8[4] === 117, `${g8[0]}, ${g8[4]} (기대 146, 117)`);

    // 18% 그레이는 어느 공간에서 오든 작업 코드 0.3857에 와야 한다 — 엔진의 기준점
    const mid = Math.pow(0.18, 1 / 1.8) * 65535;
    const srgbGray = Math.round((1.055 * Math.pow(0.18, 1 / 2.4) - 0.055) * 255);
    const fromS = working.toWorking(Uint8Array.from([srgbGray, srgbGray, srgbGray]), 3, 1, "srgb");
    const adobeGray = Math.round(Math.pow(0.18, 1 / 2.19921875) * 65535);
    const fromA = working.toWorking(Uint16Array.from([adobeGray, adobeGray, adobeGray]), 3, 1, "adobergb");
    const errS = Math.max(...Array.from(fromS, (v) => Math.abs(Math.log2(Math.pow(v / 65535, 1.8) / 0.18))));
    const errA = Math.max(...Array.from(fromA, (v) => Math.abs(Math.log2(Math.pow(v / 65535, 1.8) / 0.18))));
    ok("18% 그레이가 sRGB·Adobe RGB에서 와도 기준 자리에 온다", errS < 0.02 && errA < 0.002,
      `sRGB ${errS.toFixed(4)}스톱(8bit 양자화) · Adobe ${errA.toFixed(5)}스톱 — 기준 코드 ${mid.toFixed(0)}`);

    const img = testImage(120, 80);
    const half = working.resize(img, 60, 40);
    let la = 0, lb = 0;
    for (let i = 0; i < img.data.length; i++) la += Math.pow(img.data[i] / 65535, 1.8);
    for (let i = 0; i < half.data.length; i++) lb += Math.pow(half.data[i] / 65535, 1.8);
    la /= img.data.length; lb /= half.data.length;
    ok("축소가 선형광 평균을 보존한다", Math.abs(la - lb) / la < 1e-3, `${la.toFixed(5)} → ${lb.toFixed(5)}`);
    const odd = working.resize(img, 37, 23);
    ok("  └ 정수배가 아닌 비율도 범위 안", odd.width === 37 && odd.data.every((v) => v <= 65535));
  }

  // ── 3. 영역 ─────────────────────────────────────────────────────────────
  console.log("\n영역 렌더");
  const src = testImage(96, 64);
  {
    const off = params.defaultParams();
    off.film.enabled = false; off.grading.enabled = false; off.halation.enabled = false; off.grain.enabled = false;
    const { pl, buf } = renderWhole(src, off);
    const codes = working.toCodes16(buf, new Uint16Array(buf.length));
    ok("전부 끄면 원본이 그대로 나온다", !pl.active && same(codes, src.data) === 0);

    for (const [name, edit] of [
      ["변위 디퓨전 · 컬러 그레인", null],
      ["블러 디퓨전 · 모노 그레인", (p) => { p.grain.diffuseDisplace = false; p.grain.colorMode = "mono"; }],
    ]) {
      const p = fullParams(edit);
      const { pl, halo, buf } = renderWhole(src, p);
      const stages = ["lut", "tone", "diffusion", "halation", "grain"].filter((k) => pl[k]);
      ok(`${name} — 다섯 단계가 전부 돈다`, stages.length === 5 && !!halo && !!pl.grain.smooth,
        `${stages.join("·")} 여백 ${pl.margin}px`);

      // 띠로 — 높이를 바꿔 가며
      const bad = [];
      for (const rows of [1, 7, 20]) {
        const strips = new Float32Array(buf.length);
        pipeline.renderStrips(src, pl, halo, (b, y) => strips.set(b, y * pl.W * 3), { rows });
        const n = same(strips, buf);
        if (n) bad.push(`띠 ${rows}줄: ${n}개 다름`);
      }
      // 타일로 — 가로도 자른다(1:1 보기가 이 경로다)
      const tiles = new Float32Array(buf.length);
      for (let y = 0; y < pl.H; y += 23) {
        for (let x = 0; x < pl.W; x += 31) {
          const r = { x, y, w: Math.min(31, pl.W - x), h: Math.min(23, pl.H - y) };
          const b = pipeline.renderRegion(src, pl, r, halo);
          for (let j = 0; j < r.h; j++) tiles.set(b.subarray(j * r.w * 3, (j + 1) * r.w * 3), ((y + j) * pl.W + x) * 3);
        }
      }
      const nt = same(tiles, buf);
      if (nt) bad.push(`타일: ${nt}개 다름`);
      ok(`  └ 띠·타일로 잘라 구워도 비트 단위로 같다`, bad.length === 0, bad.join(" / "));

      // 8bit 출력의 디더도 좌표에 묶여 있어야 한다
      const whole8 = working.toSRGB8(buf, pl.W, pl.H, 0, 0, pl.W, new Uint8ClampedArray(pl.W * pl.H * 4), true);
      const part8 = new Uint8ClampedArray(whole8.length);
      for (let y = 0; y < pl.H; y += 9) {
        const rows = Math.min(9, pl.H - y);
        const b = buf.subarray(y * pl.W * 3, (y + rows) * pl.W * 3);
        part8.set(working.toSRGB8(b, pl.W, rows, 0, y, pl.W, new Uint8ClampedArray(pl.W * rows * 4), true), y * pl.W * 4);
      }
      ok(`  └ 디더까지 띠와 무관`, same(part8, whole8) === 0);
    }
  }

  // ── 3b. 마감 단계의 성질 ────────────────────────────────────────────────
  console.log("\n마감 단계");
  {
    const flat = (v, w, h) => ({ width: w, height: h, data: new Uint16Array(w * h * 3).fill(Math.round(v * 65535)) });
    const grainOnly = (edit) => {
      const p = params.defaultParams();
      p.film.enabled = false; p.grading.enabled = false; p.halation.enabled = false; p.grain.diffusion = 0;
      if (edit) edit(p);
      return p;
    };
    const stat = (img, p) => {
      const { buf } = renderWhole(img, p);
      let s = 0, s2 = 0;
      const v0 = img.data[0] / 65535;
      for (let i = 0; i < buf.length; i++) { const d = buf[i] - v0; s += d; s2 += d * d; }
      return { mean: s / buf.length, rms: Math.sqrt(s2 / buf.length), v0 };
    };
    const mid = stat(flat(0.4, 160, 120), grainOnly());
    ok("그레인이 평균 밝기를 옮기지 않는다", Math.abs(mid.mean) < mid.rms / 20 && mid.rms > 0.003,
      `평균 이동 ${mid.mean.toExponential(1)}, RMS ${mid.rms.toFixed(4)}`);
    const ZERO = 1e-6; // float32로 옮긴 원본값과의 차 — 그레인이 없다는 뜻
    ok("검정과 흰색에는 그레인이 없다", stat(flat(0, 64, 48), grainOnly()).rms < ZERO && stat(flat(1, 64, 48), grainOnly()).rms < ZERO);

    // 존 슬라이더가 **자기 톤에서만** 듣는다 — 예전 PS판은 존 범위가 겹쳐 슬라이더를 바꿔도 결과가 거의 안 변했다
    const only = (zone) => grainOnly((p) => { p.grain.shadow = p.grain.midtone = p.grain.highlight = 0; p.grain[zone] = 50; p.grain.feather = 0; });
    const dark = flat(0.15, 96, 64), bright = flat(0.85, 96, 64);
    const sd = stat(dark, only("shadow")).rms, sb = stat(bright, only("shadow")).rms;
    const hd = stat(dark, only("highlight")).rms, hb = stat(bright, only("highlight")).rms;
    ok("암부 존은 암부에만, 명부 존은 명부에만 걸린다", sd > 1e-3 && sb < ZERO && hd < ZERO && hb > 1e-3,
      `암부 존: 어두운 면 ${sd.toFixed(4)} / 밝은 면 ${sb.toFixed(4)} · 명부 존: ${hd.toFixed(4)} / ${hb.toFixed(4)}`);

    // 상대 대비(RMS ÷ 밝기)가 암부~중간톤에서 일정하다 — 포락선 g(v) ≈ v 의 뜻
    const even = grainOnly((p) => { p.grain.shadow = p.grain.midtone = p.grain.highlight = 40; });
    const w1 = stat(flat(0.1, 160, 120), even), w2 = stat(flat(0.4, 160, 120), even);
    const ratio = (w1.rms / w1.v0) / (w2.rms / w2.v0);
    ok("존 강도가 같으면 암부와 중간톤의 상대 대비가 같다", Math.abs(ratio - 1) < 0.05, `비 ${ratio.toFixed(3)}`);

    // 할레이션
    const p = params.defaultParams();
    p.film.enabled = false; p.grading.enabled = false; p.grain.enabled = false;
    p.halation.strength = 60; p.halation.radius = 5;
    const spot = (w, h) => {
      const img = flat(0.2, w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x - w / 2, dy = y - h / 2;
        if (dx * dx + dy * dy < (h * 0.15) ** 2) img.data.fill(65535, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
      return img;
    };
    const a = spot(120, 80), ra = renderWhole(a, p);
    const at = (r, w, x, y) => [0, 1, 2].map((c) => r.buf[(y * w + x) * 3 + c] - 0.2);
    const near = at(ra, 120, 60 + 16, 40), far = at(ra, 120, 60 + 40, 40);
    ok("할레이션은 R > G > B 이고 멀어질수록 준다",
      near[0] > near[1] && near[1] > near[2] && near[2] >= 0 && near[0] > far[0] && near[0] > 0.01,
      `광원 옆 +${near.map((v) => v.toFixed(3)).join("/")} · 멀리 +${far[0].toFixed(3)}`);
    const b = spot(240, 160), rb = renderWhole(b, p);
    const near2 = at(rb, 240, 120 + 32, 80);
    ok("  └ 해상도를 두 배로 해도 같은 자리 값이 같다", Math.abs(near2[0] - near[0]) < 0.02,
      `${near[0].toFixed(4)} vs ${near2[0].toFixed(4)}`);
    const dim = flat(0.3, 64, 48);
    ok("  └ 문턱을 넘는 빛이 없으면 필드를 만들지 않는다", pipeline.haloField(dim, pipeline.plan(p, dim, dim)) === null);
  }

  // ── 4. 색 — 다섯 번째 산출 경로 ─────────────────────────────────────────
  console.log("\n색 정합성");
  {
    // 격자 52 — 65535가 51로 나누어떨어져, 16bit 코드가 격자점에 정확히 온다
    const N = 52;
    const p = params.defaultParams();
    p.film.scanner = "frontier"; p.grading.toe = 10; p.grading.channelGain = { r: 1.03, g: 1, b: 0.97 };
    p.halation.enabled = false; p.grain.enabled = false;
    const table = film.buildForParams(p, N);
    const data = new Uint16Array(N * N * N * 3);
    let o = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      data[o++] = r * 1285; data[o++] = g * 1285; data[o++] = b * 1285;
    }
    const img = { width: N * N, height: N, data };
    const pl = pipeline.plan(p, img, img, { lutSize: N });
    const buf = pipeline.renderRegion(img, pl, { x: 0, y: 0, w: img.width, h: img.height }, null);
    const d = maxDiff(buf, table);
    ok("독립 실행형 === 엔진 (film.buildForParams)", d < 1e-6, `격자 ${N}³ 전 점, 최대차 ${d.toExponential(2)}`);

    // 값만이 아니라 구조 — 색을 따로 계산하는 곳이 없어야 한다
    const fs = require("fs");
    const srcText = ["core/render/pipeline.js", "apps/studio/src/session.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    ok("  └ 렌더 계층이 buildLut·bakeGrading·scanner를 직접 부르지 않는다",
      !/film\.buildLut\(|film\.bakeGrading\(|scanner\.bake\(|simulate\./.test(srcText), "buildForParams를 안 거치면 한 경로만 달라진다");
  }

  // ── 5. 세션 — 가짜 환경으로 끝까지 ──────────────────────────────────────
  console.log("\n세션 (파일 → 미리보기 → 내보내기)");
  {
    const canvases = [];
    const env = {
      inflate: async (b) => new Uint8Array(zlib.inflateSync(b)),
      decodeBitmap: async () => {
        // 브라우저가 풀어 줬다고 치는 sRGB 8bit
        const w = 80, h = 60, rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) { rgba[i * 4] = (i * 3) % 256; rgba[i * 4 + 1] = (i * 5) % 256; rgba[i * 4 + 2] = (i * 7) % 256; rgba[i * 4 + 3] = 255; }
        return { width: w, height: h, rgba };
      },
      canvasEncoder: (w, h) => {
        const c = { w, h, rgba: new Uint8ClampedArray(w * h * 4), type: null };
        canvases.push(c);
        return { put: (d, y) => c.rgba.set(d, y * w * 4), finish: async (type) => { c.type = type; return { fake: true, type }; } };
      },
      blob: (parts) => {
        const n = parts.reduce((s, b) => s + b.length, 0), out = new Uint8Array(n);
        let at = 0;
        for (const b of parts) { out.set(b, at); at += b.length; }
        return out;
      },
    };
    const s = createSession(env);
    const big = testImage(300, 200);
    const info = await s.open(makeTiff(big.data, 300, 200, 16, { compression: 8, predictor: true, icc: icc.prophoto() }).buffer, "a.tif", "image/tiff");
    ok("16bit ProPhoto TIFF를 연다", info.bits === 16 && info.space === "prophoto" && !info.assumed && info.width === 300);

    const p = fullParams((q) => { q.medium.reference = "document"; });
    const fit = s.preview(p, { mode: "fit" });
    ok("맞춤 미리보기", fit.width === 300 && fit.rgba.length === 300 * 200 * 4);

    // 1:1 보기의 사각형 = 내보낸 파일의 그 자리. 할레이션은 대리본 필드를 빌리므로
    // (여기서는 대리본 = 원본 크기라 같다) 끄지 않고 본다
    const crop = s.preview(p, { mode: "crop", x: 40, y: 30, w: 100, h: 80 });
    const out = await s.exportImage(p, { format: "tiff16" });
    const dec = await tiff.decode(out.blob);
    const pl = pipeline.plan(p, big, big, { lutSize: 33 });
    const ref = renderWhole(big, p);
    // 내보내기는 params.film.lutSize(33)로 굽는다 — 미리보기와 같은 격자라 비교가 성립한다
    const want = working.toCodes16(ref.buf, new Uint16Array(ref.buf.length));
    ok("TIFF 내보내기 === 파이프라인을 직접 돌린 값", same(dec.data, want) === 0 && icc.classify(icc.describe(dec.icc)) === "prophoto");
    const sub = new Float32Array(100 * 80 * 3);
    for (let j = 0; j < 80; j++) sub.set(ref.buf.subarray(((30 + j) * 300 + 40) * 3, ((30 + j) * 300 + 140) * 3), j * 300);
    const want8 = working.toSRGB8(sub, 100, 80, 40, 30, pl.W, new Uint8ClampedArray(100 * 80 * 4), true);
    ok("1:1 보기 === 내보낸 결과의 그 사각형", same(crop.rgba, want8) === 0);

    const jpg = await s.exportImage(p, { format: "jpeg", quality: 90 });
    const whole8 = working.toSRGB8(ref.buf, 300, 200, 0, 0, 300, new Uint8ClampedArray(300 * 200 * 4), true);
    ok("JPEG 내보내기가 같은 픽셀을 인코더에 넘긴다", jpg.ext === "jpg" && canvases[0].type === "image/jpeg" && same(canvases[0].rgba, whole8) === 0);

    const small = await s.exportImage(p, { format: "tiff16", longEdge: 150 });
    ok("긴 변을 줄여 내보낸다", small.width === 150 && small.height === 100);

    const orig = s.preview(p, { mode: "fit", original: true });
    const src8 = working.toSRGB8(Float32Array.from(big.data, (v) => v / 65535), 300, 200, 0, 0, 300, new Uint8ClampedArray(300 * 200 * 4), false);
    ok("「원본 보기」는 아무 단계도 걸지 않는다", same(orig.rgba, src8) === 0);

    const info8 = await s.open(new Uint8Array([0xff, 0xd8, 0xff]).buffer, "b.jpg", "image/jpeg");
    const warn = s.preview(p, { mode: "fit" }).warnings;
    ok("8bit 파일에 필름을 걸면 알린다", info8.bits === 8 && warn.some((m) => m.includes("8비트")), `경고 ${warn.length}건`);
    const finishOnly = fullParams((q) => { q.film.enabled = false; q.medium.reference = "document"; });
    ok("  └ 필름을 끄면(마감만) 알리지 않는다", s.preview(finishOnly, { mode: "fit" }).warnings.length === 0);

    const cubeOut = s.exportLook(p, "cube", { size: 33, space: "prophoto" });
    const xmpOut = s.exportLook(p, "xmp", { space: "prophoto" });
    ok(".cube · .xmp 룩 내보내기", /LUT_3D_SIZE 33/.test(cubeOut.text) && cubeOut.name.endsWith(".cube") && xmpOut.text.includes("x:xmpmeta") && xmpOut.name.endsWith(".xmp"));
  }

  // ── 6. 프리셋 ───────────────────────────────────────────────────────────
  console.log("\n프리셋");
  {
    const engine = R("shared/params/engine"), finish = R("shared/params/finish");
    const p = fullParams();
    const round = params.migrate(JSON.parse(JSON.stringify(p)));
    ok("저장 → 불러오기 왕복", JSON.stringify(round) === JSON.stringify(p));
    const e = engine.migrate(JSON.parse(JSON.stringify(p))), f = finish.migrate(JSON.parse(JSON.stringify(p)));
    ok("Photoshop 엔진·마감 플러그인이 각자 자기 부분을 읽는다",
      e.kind === "engine" && e.film.paper === "kodak-endura-premier" && f.kind === "finish" && f.grain.iso === 1600 && f.tone.contrast === 12);
    const fromEngine = params.migrate(engine.defaultParams());
    ok("엔진 프리셋만 열면 마감은 기본값으로 채운다", fromEngine.grain.iso === 400 && fromEngine.film.id === "kodak-portra-400");
  }

  // ── 7. 번들 — 묶은 것이 묶기 전과 같은 답을 내는가 ─────────────────────
  //
  // 배포되는 것은 소스가 아니라 `tools/build-studio.js`가 묶은 HTML 하나다. 묶는
  // 과정에서 모듈이 빠지거나 require가 남으면 **브라우저에서만** 죽는다 — 그래서
  // 워커 번들을 가짜 워커 전역에 올려 실제로 파일을 열고 미리보기를 받아 본다.
  console.log("\n번들");
  {
    const vm = require("vm");
    const { build } = require("./build-studio.js");
    const built = build();
    const html = built.html;
    ok("HTML 하나로 묶인다", html.includes("__FILMSIM_WORKER__") && !html.includes("/*__BUNDLE__*/") && !/<\/script>[\s\S]*<\/script>/.test(html.split("<script>")[1] || ""),
      `${(Buffer.byteLength(html) / 1024).toFixed(0)}KB`);

    const replies = [];
    const ctx = { postMessage: (m) => replies.push(m), console };
    ctx.self = ctx;
    vm.createContext(ctx);
    let loadError = null;
    try { vm.runInContext(built.worker, ctx); } catch (e) { loadError = e; }
    ok("워커 번들이 예외 없이 올라온다", !loadError && typeof ctx.onmessage === "function", loadError ? loadError.message : "");

    if (!loadError) {
      const img = testImage(120, 80);
      const bytes = tiff.encode({ width: 120, height: 80, bits: 16, icc: icc.prophoto() }, img.data);
      const call = async (id, method, args) => { await ctx.onmessage({ data: { id, method, args } }); return replies.find((r) => r.id === id); };
      const opened = await call(1, "open", [bytes.buffer.slice(0), "a.tif", "image/tiff"]);
      const p = fullParams((q) => { q.medium.reference = "document"; });
      const shown = await call(2, "preview", [p, { mode: "fit" }]);
      // 같은 일을 묶기 전 소스로
      const direct = createSession({});
      await direct.open(bytes.buffer.slice(0), "a.tif", "image/tiff");
      const want = direct.preview(p, { mode: "fit" });
      ok("번들 === 소스 (파일 열기 → 미리보기)",
        opened && !opened.error && shown && !shown.error && same(shown.result.rgba, want.rgba) === 0,
        (opened && opened.error) || (shown && shown.error) || `${shown.result.width}×${shown.result.height}`);
    }
  }

  console.log(fails ? `\n독립 실행형 검사 실패 ${fails}건` : "\n독립 실행형 검사 통과");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
