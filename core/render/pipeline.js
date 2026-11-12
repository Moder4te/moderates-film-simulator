/**
 * 독립 실행형 렌더 파이프라인 — 색(엔진)과 마감을 **한 번의 계산**으로.
 *
 *   원본(작업 공간) → 필름 LUT → 톤 → 디퓨전 → 할레이션 → 그레인 → 출력
 *
 * Photoshop 플러그인은 단계마다 합성본을 읽고 레이어를 한 장씩 얹었다. 그 구조가
 * 만든 제약이 셋 있었다 — 색을 마감보다 **먼저** 적용해야 했고(디퓨전이 합성본을
 * 구운 스탬프라 되돌릴 지점이 없다), 재적용 때 자기 레이어를 찾아 지워야 했고,
 * 그레인은 Overlay + Blend If로만 얹을 수 있었다. 여기는 원본을 쥐고 **매번 처음부터**
 * 계산하므로 셋 다 없다. 순서는 고정이고 누적될 것이 없다.
 *
 * ── 영역 단위로 굽는다 ──────────────────────────────────────────────────
 *
 * 모든 단계가 **"전체 이미지 좌표 (x, y)의 값"으로 정의**돼 있다. 그래서 어느
 * 사각형을 어떤 순서로 굽든 이어 붙이면 전체를 한 번에 구운 것과 **비트 단위로
 * 같다**(`tools/check-studio.js`가 지킨다). 이것 하나로 세 가지가 풀린다.
 *
 *   큰 파일      띠로 나눠 굽는다. 60MP를 float으로 통째로 들면 720MB다
 *   1:1 보기     화면에 보이는 사각형만 원본 해상도로 굽는다(TODO P1이 찾던 것)
 *   일관성       미리보기·크롭·내보내기가 같은 함수다
 *
 * 그러려면 단계마다 조건이 있다.
 *
 *   점 연산(LUT·톤)   그대로 성립
 *   디퓨전            이웃을 읽는다 → 여백(`plan.margin`)을 붙여 굽고 안쪽만 쓴다.
 *                     변위는 순차 난수가 아니라 **셀 좌표의 해시**로 정한다
 *   할레이션          빛이 이미지 전역으로 번진다 → 번짐 필드를 **먼저 따로** 구해
 *                     (`haloField`) 영역 렌더에는 조회만 남긴다
 *   그레인            필드가 좌표의 해시다(`grainfield.channelFieldRegion`)
 *   디더              절대 좌표로 표를 조회한다(`working.toSRGB8`)
 *
 * ── 렌더 공간 ───────────────────────────────────────────────────────────
 *
 * `plan`은 **렌더할 크기**에 묶인다. 미리보기 대리본은 원본의 축소판이라, 물리 크기
 * (입자 px·할레이션 반경·디퓨전 반경)를 전부 그 비율(`scale`)로 줄인다. 입자가 1px
 * 밑으로 내려가면 크기 대신 세기로 환산한다 — 픽셀보다 고운 입자는 그 자리에서
 * 평균되어 진폭이 준다(`core/optics/format.js`의 `grainSize`와 같은 규칙).
 */

const film = require("../color/film");
const lut = require("../color/lut");
const inputs = require("../color/inputs");
const paper = require("../color/paper");
const tone = require("../optics/tone");
const format = require("../optics/format");
const halation = require("../optics/halation");
const grainfield = require("../optics/grainfield");
const { zoneRanges, blendWeight } = require("../optics/grainzones");
const working = require("./working");

const MAX16 = working.MAX16;
const GAMMA = working.GAMMA;

// ── 마감: 새로 설계한 부분 ───────────────────────────────────────────────

/**
 * 그레인의 **톤 포락선** g(v) = v·(1 − v⁴).
 *
 * 그레인은 농도의 요동이라 밝기에 **곱으로** 걸린다 — 눈에는 상대 대비(Weber)가
 * 일정하게 보인다. 그래서 암부~중간톤은 g ≈ v다. 다만 종이 흰색에는 입자가 없다.
 * 인화지 발끝이 농도 차를 눌러 버리기 때문이다. 그래서 흰색으로 갈수록 0으로 닫는다.
 *
 * Photoshop판은 이것을 Overlay 블렌드로 흉내 냈다. Overlay의 포락선은 텐트
 * (v<0.5에서 v, 위에서 1−v)라 0.5에서 꺾이고, 명부 상대 대비가 너무 빨리 죽어서
 * (L=212에서 10%) 명부 존에만 2.2배 이득을 따로 걸어 메웠다(`HIGHLIGHT_GAIN`).
 * 이 식은 꺾임이 없고 같은 자리에서 상대 대비 52%를 남긴다 — 보상 상수 없이
 * 그 보상 뒤의 값(0.2 × 2.2 = 44%)과 비슷한 자리에 온다. 세 존 슬라이더가 이제
 * **같은 단위**다.
 */
function grainEnvelope(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 0;
  const v2 = v * v;
  return v * (1 - v2 * v2);
}

/** Overlay 변조 진폭(Photoshop판의 `amp: 0.5`) — 프리셋 강도의 뜻을 그대로 잇는다. */
const GRAIN_AMP = 0.5;

/**
 * 셀 좌표 → 변위. 순차 난수 대신 해시를 쓴다 — 셀이 어느 띠에 걸리든 같은 값이어야
 * 띠로 나눠 구울 수 있다. 반환은 [-0.5, 0.5).
 */
function cellHash(ix, iy, salt) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 - 0.5;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { r, k };
}

// ── 계획 ─────────────────────────────────────────────────────────────────

/**
 * 파라미터 → 렌더 계획. 단계별 상수(LUT·표·크기)를 한 번 계산해 둔다.
 *
 * @param {object} params  합쳐진 파라미터(엔진 + 마감 스키마. `shared/params`)
 * @param {{width:number,height:number}} full    원본 크기 — 물리 크기의 기준
 * @param {{width:number,height:number}} [size]  렌더할 크기. 없으면 원본
 * @param {object} [opts]
 * @param {number} [opts.lutSize]  필름 LUT 격자. 없으면 params.film.lutSize(기본 33)
 * @param {(key:string, build:()=>Float32Array)=>Float32Array} [opts.lutCache]
 */
function plan(params, full, size, opts) {
  const o = opts || {};
  const W = (size && size.width) || full.width;
  const H = (size && size.height) || full.height;
  const fullEdge = Math.max(full.width, full.height);
  const scale = Math.max(W, H) / fullEdge;
  const pl = { W, H, scale, margin: 0, lut: null, tone: null, diffusion: null, halation: null, grain: null };

  // ── 색(엔진) — 정의는 `film.buildForParams` 하나다. 네 산출 경로에 이어 다섯 번째
  if (film.hasEffect(params)) {
    const n = o.lutSize || (params.film && params.film.lutSize) || 33;
    const build = () => film.buildForParams(params, n);
    const key = JSON.stringify([n, params.film, params.grading]);
    pl.lut = { size: n, table: o.lutCache ? o.lutCache(key, build) : build() };
  }

  // ── 톤 — `core/optics/tone.js`의 채널 체인을 그대로 표로 굽는다
  const tn = params.tone;
  if (tone.hasEffect(tn)) {
    const k = tone.coefficients(tn);
    const N = 4095;
    pl.tone = { N, luts: tone.buildChannelLuts(k, N, GAMMA), saturation: k.saturation, vibrance: k.vibrance };
  }

  const medium = params.medium || {};
  const g = params.grain || {};
  if (g.enabled) {
    const sizing = format.grainSize(full, medium, g.iso);
    const px = sizing.px * scale; // 렌더 공간의 입자 크기
    const amount = px < 1 ? Math.max(0.25, px) : 1;

    // 디퓨전 — 해상도를 입자 크기에 묶는다. 크기는 원본 기준으로 정하고 축소한다
    const amt = g.diffusion || 0;
    if (amt > 0) {
      if (g.diffuseDisplace) {
        const radius = Math.max(0.5, sizing.px * (amt / 100)) * scale;
        // 반경 0.5 아래는 반올림하면 전부 0이다 — 축소본에서는 보이지 않는 게 맞다
        if (radius >= 0.5) {
          pl.diffusion = { mode: "displace", radius, cell: Math.max(1, Math.round(px)) };
          pl.margin = Math.ceil(radius) + 1;
        }
      } else {
        const sigma = Math.max(0.6, sizing.px * 1.3) * scale;
        if (sigma >= 0.25) {
          const kern = gaussKernel(sigma);
          pl.diffusion = { mode: "blur", sigma, amount: amt / 100, kern };
          pl.margin = kern.r;
        }
      }
    }

    const strengths = [g.shadow || 0, g.midtone || 0, g.highlight || 0];
    if (strengths.some((s) => s > 0)) {
      const cloud = format.dyeClouds(px, g);
      const rgb = g.colorMode === "rgb";
      const ranges = zoneRanges(g.crossover1, g.crossover2, g.feather);
      // 존 가중치 × 강도를 광도 0~255에 대한 표로. 가중치 합은 어디서나 1이다
      const env = new Float32Array(257);
      for (let L = 0; L <= 255; L++) {
        env[L] = GRAIN_AMP * amount * (
          (strengths[0] / 100) * blendWeight(ranges.shadow, L) +
          (strengths[1] / 100) * blendWeight(ranges.midtone, L) +
          (strengths[2] / 100) * blendWeight(ranges.highlight, L));
      }
      env[256] = env[255];
      const sigma = format.gridSmoothPx(g.iso, sizing.longEdge) * scale;
      pl.grain = {
        cell: Math.max(1, px),
        rgb,
        amps: rgb ? [cloud.amps.r, cloud.amps.g, cloud.amps.b] : [1, 1, 1],
        cellScale: rgb ? [cloud.cellScale.r, cloud.cellScale.g, cloud.cellScale.b] : [1, 1, 1],
        clumpScale: cloud.clumpScale,
        env,
        smooth: sigma >= 0.3 ? gaussKernel(sigma) : null,
        seed: 1,
      };
    }
  }

  const h = params.halation || {};
  if (h.enabled && h.strength > 0) {
    // 반경은 긴 변 대비 %라 렌더 크기에 저절로 비례한다. 포맷 배율은 필름면 고정 거리
    const radiusPx = Math.max(0.1, (Math.max(W, H) * h.radius) / 100) * format.relativeScale(medium.format);
    const knee = Math.pow(Math.min(h.threshold, 254) / 255, GAMMA);
    pl.halation = {
      radiusPx,
      knee,
      gain: h.strength * halation.GAIN_PER_STRENGTH,
      // 가장 좁은 가우시안(σ 0.3R)이 축소본에서 2px 이상 남게 — halation.js와 같은 규칙
      f: Math.max(1, Math.floor((halation.KERNEL[0].sigma * radiusPx) / 2)),
    };
  }

  pl.active = !!(pl.lut || pl.tone || pl.diffusion || pl.halation || pl.grain);
  return pl;
}

/** 할레이션 필드를 다시 구해야 하는지 가르는 키 — 그레인만 바꿨으면 그대로 쓴다. */
function haloKey(params) {
  const h = params.halation || {};
  if (!h.enabled || !(h.strength > 0)) return "";
  return JSON.stringify([params.film, params.grading, params.tone, h, (params.medium || {}).format]);
}

// ── 단계 ─────────────────────────────────────────────────────────────────

/**
 * 점 연산(LUT → 톤)을 사각형 하나에. 이웃을 안 보므로 어디를 잘라도 같다.
 * @returns {Float32Array} w·h·3, 작업 인코딩 0~1
 */
function pointStages(src, pl, x0, y0, w, h) {
  const out = new Float32Array(w * h * 3);
  const data = src.data, sw = src.width;
  const inv = 1 / MAX16;
  const L = pl.lut, T = pl.tone;
  const px = [0, 0, 0];
  const doSat = T && (T.saturation !== 0 || T.vibrance !== 0);
  for (let y = 0, o = 0; y < h; y++) {
    let i = ((y0 + y) * sw + x0) * 3;
    for (let x = 0; x < w; x++, i += 3, o += 3) {
      px[0] = data[i] * inv; px[1] = data[i + 1] * inv; px[2] = data[i + 2] * inv;
      if (L) lut.sample(L.table, L.size, px[0], px[1], px[2], px);
      if (T) {
        for (let c = 0; c < 3; c++) {
          const v = px[c] <= 0 ? 0 : px[c] >= 1 ? 1 : px[c];
          const u = v * T.N, k = u >= T.N ? T.N - 1 : u | 0;
          const t = T.luts[c];
          px[c] = t[k] + (t[k + 1] - t[k]) * (u - k);
        }
        if (doSat) {
          const Y = tone.luma(px[0], px[1], px[2]);
          let s = 1 + T.saturation;
          if (T.vibrance !== 0) {
            const mx = Math.max(px[0], px[1], px[2]);
            const mn = Math.min(px[0], px[1], px[2]);
            const local = mx > 1e-6 ? (mx - mn) / mx : 0;
            s += T.vibrance * (1 - (local < 0 ? 0 : local > 1 ? 1 : local));
          }
          px[0] = Y + (px[0] - Y) * s; px[1] = Y + (px[1] - Y) * s; px[2] = Y + (px[2] - Y) * s;
        }
        tone.fitGamut(px);
      }
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2];
    }
  }
  return out;
}

/**
 * 디퓨전 — 여백 붙은 버퍼 P에서 안쪽 사각형을 뽑는다.
 *
 * 변위: 입자 크기 셀마다 오프셋 하나. 셀 안은 함께 움직이고 셀끼리는 독립이라
 *       미세 선이 **조각난다**(`core/optics/displace.js`의 설계 그대로, 난수만 해시로).
 * 블러: 가우시안을 원본과 섞는다. 미세 선이 흐려진 채 남는다.
 *
 * 가장자리는 **이미지 경계**에 붙인다(P 경계가 아니다) — 여백이 반경보다 넓어서
 * 이미지 안쪽에서는 P를 벗어날 일이 없다.
 */
function diffuse(P, pb, pl, region) {
  const d = pl.diffusion;
  const { x, y, w, h } = region;
  const out = new Float32Array(w * h * 3);
  const maxX = pl.W - 1, maxY = pl.H - 1;

  if (d.mode === "displace") {
    const span = 2 * d.radius, cell = d.cell;
    for (let j = 0, o = 0; j < h; j++) {
      const Y = y + j, cy = Math.floor(Y / cell);
      for (let i = 0; i < w; i++, o += 3) {
        const X = x + i, cx = Math.floor(X / cell);
        let sx = X + Math.round(cellHash(cx, cy, 11) * span);
        let sy = Y + Math.round(cellHash(cx, cy, 23) * span);
        sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
        sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
        const s = ((sy - pb.y) * pb.w + (sx - pb.x)) * 3;
        out[o] = P[s]; out[o + 1] = P[s + 1]; out[o + 2] = P[s + 2];
      }
    }
    return out;
  }

  // 블러 — 가로 먼저(안쪽 열 × 여백 포함 행), 그다음 세로
  const { r, k } = d.kern;
  const rows = h + 2 * r;
  const tmp = new Float32Array(w * rows * 3);
  for (let j = 0; j < rows; j++) {
    let Y = y - r + j; Y = Y < 0 ? 0 : Y > maxY ? maxY : Y;
    const rowBase = (Y - pb.y) * pb.w;
    for (let i = 0; i < w; i++) {
      let a = 0, b = 0, c = 0;
      for (let t = -r; t <= r; t++) {
        let X = x + i + t; X = X < 0 ? 0 : X > maxX ? maxX : X;
        const s = (rowBase + X - pb.x) * 3, kw = k[t + r];
        a += P[s] * kw; b += P[s + 1] * kw; c += P[s + 2] * kw;
      }
      const o = (j * w + i) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  const amt = d.amount;
  for (let j = 0, o = 0; j < h; j++) {
    for (let i = 0; i < w; i++, o += 3) {
      let a = 0, b = 0, c = 0;
      for (let t = -r; t <= r; t++) {
        const s = ((j + r + t) * w + i) * 3, kw = k[t + r];
        a += tmp[s] * kw; b += tmp[s + 1] * kw; c += tmp[s + 2] * kw;
      }
      const s0 = ((y + j - pb.y) * pb.w + (x + i - pb.x)) * 3;
      out[o] = P[s0] + (a - P[s0]) * amt;
      out[o + 1] = P[s0 + 1] + (b - P[s0 + 1]) * amt;
      out[o + 2] = P[s0 + 2] + (c - P[s0 + 2]) * amt;
    }
  }
  return out;
}

/**
 * 할레이션 번짐 필드 — 이미지 **전체**에서 한 번 구한다.
 *
 * 적감층에 닿은 빛 중 문턱을 넘는 초과분을 축소 격자에 면적 평균으로 모으고,
 * 지수 감쇠 커널로 번진다(`core/optics/halation.js`의 `spread` — 에너지 보존).
 *
 * ⚠️ 소스는 **디퓨전 전** 값이다. 디퓨전은 입자 크기 안에서만 픽셀을 옮기고 이
 * 격자는 그보다 훨씬 성기므로(칸 = 0.15R) 평균이 같다. 그 대신 이 패스가 점 연산
 * 만으로 끝나 여백 없이 띠로 돈다.
 *
 * @returns {{field:Float32Array, sw:number, sh:number, f:number, srcW:number}|null}
 *   문턱을 넘는 빛이 없으면 null
 */
function haloField(src, pl, onProgress) {
  const hp = pl.halation;
  if (!hp) return null;
  const { W, H } = pl;
  const f = hp.f;
  const sw = Math.ceil(W / f), sh = Math.ceil(H / f);
  const small = new Float32Array(sw * sh);
  const count = new Float32Array(sw * sh);
  const kneeScale = 1 / (1 - hp.knee);
  let any = false;
  const STRIP = 128;
  for (let y0 = 0; y0 < H; y0 += STRIP) {
    const rows = Math.min(STRIP, H - y0);
    const P = pointStages(src, pl, 0, y0, W, rows);
    for (let y = 0, o = 0; y < rows; y++) {
      const row = (((y0 + y) / f) | 0) * sw;
      for (let x = 0; x < W; x++, o += 3) {
        const j = row + ((x / f) | 0);
        count[j]++;
        const L = working.decode(P[o]);
        if (L > hp.knee) { small[j] += (L - hp.knee) * kneeScale; any = true; }
      }
    }
    if (onProgress) onProgress((y0 + rows) / H);
  }
  if (!any) return null;
  for (let j = 0; j < small.length; j++) small[j] /= count[j];
  return { field: halation.spread(small, sw, sh, hp.radiusPx / f), sw, sh, f, srcW: W };
}

/** 번짐 필드를 **선형광에서** 더한다. 색은 적감층 재노광 비율(R 1 : G 0.07 : B 0.01). */
function addHalo(buf, pl, region, halo) {
  const { x, y, w, h } = region;
  const { field, sw, sh } = halo;
  // 필드가 다른 해상도에서 구해졌어도(대리본 → 1:1 크롭) 같은 자리를 읽는다
  const k = halo.srcW / pl.W / halo.f;
  const gain = pl.halation.gain;
  const LAYER = halation.LAYER;
  for (let j = 0, o = 0; j < h; j++) {
    let fy = (y + j + 0.5) * k - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(fy | 0, sh - 1), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let i = 0; i < w; i++, o += 3) {
      let fx = (x + i + 0.5) * k - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(fx | 0, sw - 1), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const a = field[y0 * sw + x0], b = field[y0 * sw + x1];
      const c = field[y1 * sw + x0], d = field[y1 * sw + x1];
      const top = a + (b - a) * tx;
      const hv = gain * (top + (c + (d - c) * tx - top) * ty);
      if (hv <= 1e-7) continue; // 더할 게 없으면 그대로(비트 동일)
      for (let ch = 0; ch < 3; ch++) {
        const L = working.decode(buf[o + ch]) + hv * LAYER[ch];
        buf[o + ch] = working.encode(L > 1 ? 1 : L);
      }
    }
  }
}

/** 한 채널의 그레인 필드를 영역에 대해. 격자 마디 완화(있으면)는 여백을 붙여 건다. */
function grainChannel(pl, region, c) {
  const g = pl.grain;
  const pad = g.smooth ? g.smooth.r : 0;
  const reg = {
    x: region.x - pad, y: region.y - pad, w: region.w + 2 * pad, h: region.h + 2 * pad,
    fullW: pl.W, fullH: pl.H,
  };
  // 채널마다 다른 시드 → 독립 필드. 모노는 한 장을 세 채널이 나눠 쓴다
  const seed = g.seed + (g.rgb ? c * 101 : 0);
  const f = grainfield.channelFieldRegion(reg, g.cell * g.cellScale[c], g.clumpScale, grainfield.mulberry32(seed));
  if (!pad) return f;

  const { r, k } = g.smooth;
  const tmp = new Float32Array(region.w * reg.h);
  for (let j = 0; j < reg.h; j++) {
    for (let i = 0; i < region.w; i++) {
      let a = 0;
      for (let t = -r; t <= r; t++) a += f[j * reg.w + i + pad + t] * k[t + r];
      tmp[j * region.w + i] = a;
    }
  }
  const out = new Float32Array(region.w * region.h);
  for (let j = 0; j < region.h; j++) {
    for (let i = 0; i < region.w; i++) {
      let a = 0;
      for (let t = -r; t <= r; t++) a += tmp[(j + pad + t) * region.w + i] * k[t + r];
      out[j * region.w + i] = a;
    }
  }
  return out;
}

/**
 * 그레인 — v' = v + A(Y)·a_c·n_c·g(v).
 *
 *   A(Y)   존 강도 × 존 가중치(밑 픽셀의 광도로 조회). 세 존의 가중치 합은 늘 1
 *   a_c    채널 진폭(염료 구름 — 청색이 가장 시끄럽다)
 *   n_c    값 노이즈 필드, 대략 [-1, 1]
 *   g(v)   톤 포락선(위 `grainEnvelope`)
 *
 * 광도는 **그레인을 얹기 전** 값에서 읽는다 — 세 채널이 같은 A를 받아야 존 경계에서
 * 색이 갈라지지 않는다.
 */
function addGrain(buf, pl, region) {
  const g = pl.grain;
  const n = region.w * region.h;
  const fields = g.rgb
    ? [grainChannel(pl, region, 0), grainChannel(pl, region, 1), grainChannel(pl, region, 2)]
    : null;
  const mono = g.rgb ? null : grainChannel(pl, region, 0);
  const env = g.env;
  const px = [0, 0, 0];
  for (let p = 0, o = 0; p < n; p++, o += 3) {
    const r = buf[o], gg = buf[o + 1], b = buf[o + 2];
    let Y = tone.luma(r, gg, b) * 255;
    Y = Y < 0 ? 0 : Y > 255 ? 255 : Y;
    const k = Y | 0;
    const A = env[k] + (env[k + 1] - env[k]) * (Y - k);
    if (A === 0) continue;
    px[0] = r + A * g.amps[0] * (fields ? fields[0][p] : mono[p]) * grainEnvelope(r);
    px[1] = gg + A * g.amps[1] * (fields ? fields[1][p] : mono[p]) * grainEnvelope(gg);
    px[2] = b + A * g.amps[2] * (fields ? fields[2][p] : mono[p]) * grainEnvelope(b);
    tone.fitGamut(px);
    buf[o] = px[0]; buf[o + 1] = px[1]; buf[o + 2] = px[2];
  }
}

// ── 렌더 ─────────────────────────────────────────────────────────────────

/**
 * 사각형 하나를 굽는다.
 *
 * @param {{width:number,height:number,data:Uint16Array}} src  렌더 크기의 원본(작업 공간)
 * @param {object} pl      `plan`
 * @param {{x:number,y:number,w:number,h:number}} region  src 좌표
 * @param {object|null} halo  `haloField`의 결과. 할레이션이 꺼졌거나 번질 빛이 없으면 null
 * @returns {Float32Array} w·h·3, 작업 인코딩 0~1
 */
function renderRegion(src, pl, region, halo) {
  if (src.width !== pl.W || src.height !== pl.H) {
    throw new Error(`렌더 계획(${pl.W}×${pl.H})과 원본(${src.width}×${src.height}) 크기가 다릅니다`);
  }
  const m = pl.diffusion ? pl.margin : 0;
  const pb = {
    x: Math.max(0, region.x - m),
    y: Math.max(0, region.y - m),
  };
  pb.w = Math.min(pl.W, region.x + region.w + m) - pb.x;
  pb.h = Math.min(pl.H, region.y + region.h + m) - pb.y;

  const P = pointStages(src, pl, pb.x, pb.y, pb.w, pb.h);
  const buf = pl.diffusion ? diffuse(P, pb, pl, region) : P;
  if (pl.halation && halo) addHalo(buf, pl, region, halo);
  if (pl.grain) addGrain(buf, pl, region);
  return buf;
}

/**
 * 이미지 전체를 띠로 굽는다. 띠마다 `sink(buf, y, rows)`를 부른다.
 * 띠 높이는 결과와 무관하다 — 메모리와 진행 표시의 단위일 뿐이다.
 */
function renderStrips(src, pl, halo, sink, opts) {
  const o = opts || {};
  const rowsPer = o.rows || Math.max(16, Math.min(512, Math.floor(2_000_000 / pl.W)));
  for (let y = 0; y < pl.H; y += rowsPer) {
    const rows = Math.min(rowsPer, pl.H - y);
    sink(renderRegion(src, pl, { x: 0, y, w: pl.W, h: rows }, halo), y, rows);
    if (o.onProgress) o.onProgress((y + rows) / pl.H);
  }
}

// ── 조언 ─────────────────────────────────────────────────────────────────

/**
 * 조용히 틀리는 설정을 알린다. **막지 않는다** — 알고 하는 작업일 수 있다.
 * Photoshop판 `apply.validate`의 자리인데 항목이 다르다: 색공간 경고는 없어졌고
 * (열 때 옮긴다 — `working.js`), 마감이 먼저 얹혔다는 경고도 없어졌다(순서가 고정이다).
 *
 * @param {object} params
 * @param {{width:number,height:number,bits:number,space:string,assumed:boolean,format:string}} info 원본 정보
 * @returns {string[]}
 */
function advise(params, info) {
  const out = [];
  const f = params.film || {};
  const filmOn = f.enabled !== false;

  if (info && info.assumed) {
    out.push(
      `이 파일에는 색 프로파일이 없어 ${working.SOURCE_SPACES[info.space].displayName}로 가정했습니다. ` +
        "다른 공간으로 저장한 파일이면 색이 어긋납니다."
    );
  }
  if (filmOn && info && info.raw) {
    // RAW는 화이트 레벨 기준 선형으로 들어온다. 「리니어 +N스톱」이 아니면 엔진이 그 값을
    // 이미 톤이 잡힌 사진으로 읽어 통째로 어둡고 대비가 틀어진다
    if (!/^linear-h/.test(f.input || "")) {
      out.push(
        "RAW는 톤 커브 없이 현상(플랫 현상)해 들어옵니다. 필름의 입력 소스를 「리니어 +N스톱」으로 " +
          "두어야 맞게 읽습니다 — 지금 설정으로는 어둡고 대비가 틀어집니다."
      );
    }
    if (info.raw.clippedPercent > 1) {
      out.push(
        `화소의 ${info.raw.clippedPercent.toFixed(1)}%가 센서 포화에 닿아 있습니다. ` +
          "그 부분은 RAW에도 정보가 없어 되살릴 수 없습니다."
      );
    }
  }
  if (filmOn && info) {
    if (info.bits !== 16) {
      out.push(
        "필름 엔진은 톤 커브 없이 현상한 16비트 파일을 전제로 합니다. 이 파일은 8비트라 " +
          "이미 카메라·현상기의 톤 커브가 걸려 있습니다 — 필름 곡선이 그 위에 한 번 더 곱해집니다. " +
          "색이 이미 정해진 파일이라면 필름을 끄고 마감만 쓰는 편이 맞습니다."
      );
    }
    const combo = inputs.combinationWarning(f.input, !!paper.byId(f.paper).curves);
    if (combo) out.push(combo);
  }
  const g = params.grain || {};
  if (g.enabled && info) {
    const edge = Math.max(info.width, info.height);
    const ref = format.longEdgeFor(info, (params.medium || {}).reference, (params.medium || {}).customLongEdge);
    if (ref !== edge) {
      out.push(
        `입자 크기 기준(${ref}px)이 이 이미지의 긴 변(${edge}px)과 다릅니다. ` +
          `입자가 ${(ref / edge).toFixed(2)}배 크기로 그려집니다 — 그 크기로 내보낼 것이 아니면 기준을 「문서」로 두세요.`
      );
    }
  }
  return out;
}

module.exports = {
  plan, haloKey, haloField, renderRegion, renderStrips, pointStages, advise,
  grainEnvelope, GRAIN_AMP,
};
