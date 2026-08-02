// docs/PLAN-GRAIN-2026-08-02.md M1. 필름 스캔(16비트 PPM)에서 그레인 통계를 뽑는다.
//
// 입력은 RAW가 아니라 PPM이다 — RAW 디코딩(rawpy)은 tools/decode-arq.py가 하고,
// 이 파일은 의존성 0으로 유지한다(node_modules 없음, 이 저장소 원칙).
//
//   python tools/decode-arq.py scan.ARQ scan.ppm
//   node tools/measure-scan.js scan.ppm --patch <cy>,<cx> [scan2.ppm] [옵션]
//
// 두 번째 PPM(같은 자리 재촬영)을 주면 센서 잡음을 구적으로 뺀다 — 단
// docs/PLAN-GRAIN-2026-08-02.md의 "실측 확인" 절 참고: 컴포짓 내부 진동이 섞여
// 이 저장소의 리그에서는 상한값이다.

"use strict";
const fs = require("fs");

// ---------------------------------------------------------------- PPM 읽기

function readPPM(path) {
  const buf = fs.readFileSync(path);
  let pos = 0;
  function readToken() {
    // 공백으로 토큰을 나누고 '#' 주석 줄은 건너뛴다 (PPM 규격)
    while (pos < buf.length) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23 /* # */) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString("ascii", start, pos);
  }
  const magic = readToken();
  if (magic !== "P6") throw new Error(`${path}: P6 PPM 아님 (magic=${magic})`);
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const maxval = parseInt(readToken(), 10);
  pos += 1; // 헤더 다음 단일 공백 문자
  const bytesPerSample = maxval > 255 ? 2 : 1;
  const expected = width * height * 3 * bytesPerSample;
  if (buf.length - pos < expected) throw new Error(`${path}: 데이터 부족 (${buf.length - pos} < ${expected})`);
  const data = new Uint16Array(width * height * 3);
  if (bytesPerSample === 2) {
    for (let i = 0; i < data.length; i++) data[i] = buf.readUInt16BE(pos + i * 2); // PPM 16비트는 빅엔디안
  } else {
    for (let i = 0; i < data.length; i++) data[i] = buf[pos + i];
  }
  return { width, height, maxval, data };
}

// 채널 c(0=R,1=G,2=B)의 size×size 패치를 (y0,x0)에서 잘라 Float64Array로.
function cropChannel(img, c, y0, x0, size) {
  const out = new Float64Array(size * size);
  const { width, data } = img;
  for (let y = 0; y < size; y++) {
    const row = (y0 + y) * width;
    for (let x = 0; x < size; x++) {
      out[y * size + x] = data[(row + x0 + x) * 3 + c];
    }
  }
  return out;
}

// ---------------------------------------------------------------- 가우시안 하이패스

function gaussianKernel1D(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

// 분리형 가우시안 블러. 가장자리는 복제(replicate) 경계.
function gaussianBlur(patch, size, sigma) {
  const k = gaussianKernel1D(sigma);
  const radius = (k.length - 1) / 2;
  const tmp = new Float64Array(size * size);
  const out = new Float64Array(size * size);
  const clamp = (v) => (v < 0 ? 0 : v >= size ? size - 1 : v);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += patch[y * size + clamp(x + i)] * k[i + radius];
      tmp[y * size + x] = acc;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += tmp[clamp(y + i) * size + x] * k[i + radius];
      out[y * size + x] = acc;
    }
  }
  return out;
}

function highpass(patch, size, sigma) {
  const blurred = gaussianBlur(patch, size, sigma);
  const out = new Float64Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = patch[i] - blurred[i];
  return out;
}

// ---------------------------------------------------------------- FFT (radix-2, size는 2의 거듭제곱)

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
        curWi = curWr * wi + curWi * wr;
        curWr = nwr;
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// 정사각 size×size(2의 거듭제곱) 2D FFT. re/im은 in-place로 바뀐다.
function fft2D(re, im, size, invert) {
  const rowRe = new Float64Array(size), rowIm = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) { rowRe[x] = re[y * size + x]; rowIm[x] = im[y * size + x]; }
    fft1D(rowRe, rowIm, invert);
    for (let x = 0; x < size; x++) { re[y * size + x] = rowRe[x]; im[y * size + x] = rowIm[x]; }
  }
  const colRe = new Float64Array(size), colIm = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) { colRe[y] = re[y * size + x]; colIm[y] = im[y * size + x]; }
    fft1D(colRe, colIm, invert);
    for (let y = 0; y < size; y++) { re[y * size + x] = colRe[y]; im[y * size + x] = colIm[y]; }
  }
}

function fftShift2D(arr, size) {
  const out = new Float64Array(size * size);
  const h = size >> 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[((y + h) % size) * size + ((x + h) % size)] = arr[y * size + x];
    }
  }
  return out;
}

// 중심에서 반경 win까지 원형 평균 프로파일. radial[r] < 1/e인 첫 r을 상관길이로 쓴다.
function radialProfile(shifted, size, win) {
  const cy = size >> 1, cx = size >> 1;
  const sum = new Float64Array(win), cnt = new Int32Array(win);
  for (let dy = -win; dy < win; dy++) {
    for (let dx = -win; dx < win; dx++) {
      const r = Math.round(Math.sqrt(dy * dy + dx * dx));
      if (r >= win) continue;
      sum[r] += shifted[(cy + dy) * size + (cx + dx)];
      cnt[r]++;
    }
  }
  const profile = new Float64Array(win);
  for (let r = 0; r < win; r++) profile[r] = cnt[r] ? sum[r] / cnt[r] : 0;
  return profile;
}

// 1/e 문턱 교차를 선형보간으로 서브픽셀까지 잰다. 정수 px만 쓰면 PSF sigma와
// 같은 자릿수(3~4px)에서 구적 보정이 통째로 0으로 무너진다(실측으로 확인).
function firstBelowInvE(profile) {
  const threshold = profile[0] / Math.E;
  for (let r = 1; r < profile.length; r++) {
    if (profile[r] < threshold) {
      const prev = profile[r - 1];
      const frac = (prev - threshold) / (prev - profile[r] || 1e-12);
      return r - 1 + Math.max(0, Math.min(1, frac));
    }
  }
  return profile.length;
}

// 단일 패치 자기상관 상관길이 (Wiener-Khinchin). 센서 잡음이 0-lag를 지배해
// 짧게 잡힐 수 있다 — 두 프레임이 있으면 crossCorrLength를 쓴다.
function autoCorrLength(patch, size, win) {
  const re = Float64Array.from(patch), im = new Float64Array(size * size);
  fft2D(re, im, size, false);
  const power = new Float64Array(size * size);
  for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  const zeros = new Float64Array(size * size);
  fft2D(power, zeros, size, true);
  const shifted = fftShift2D(power, size);
  const norm = shifted[(size >> 1) * size + (size >> 1)] || 1;
  for (let i = 0; i < shifted.length; i++) shifted[i] /= norm;
  const profile = radialProfile(shifted, size, win);
  return { corrLenPx: firstBelowInvE(profile), profile: Array.from(profile.slice(0, 8)) };
}

// 두 프레임(같은 자리, 정렬됨) 간 교차상관. 서로 독립인 센서 잡음이 0-lag에서
// 자동으로 빠져 그레인만 남는다 — 2026-08-02 실측으로 검증(자기상관 1~2px →
// 교차상관 6px, 계획서 기대치와 일치).
function crossCorrLength(patchA, patchB, size, win) {
  const reA = Float64Array.from(patchA), imA = new Float64Array(size * size);
  const reB = Float64Array.from(patchB), imB = new Float64Array(size * size);
  fft2D(reA, imA, size, false);
  fft2D(reB, imB, size, false);
  const re = new Float64Array(size * size), im = new Float64Array(size * size);
  for (let i = 0; i < re.length; i++) {
    // FA * conj(FB)
    re[i] = reA[i] * reB[i] + imA[i] * imB[i];
    im[i] = imA[i] * reB[i] - reA[i] * imB[i];
  }
  fft2D(re, im, size, true);
  const shifted = fftShift2D(re, size);
  let norm = -Infinity;
  for (let i = 0; i < shifted.length; i++) if (shifted[i] > norm) norm = shifted[i];
  if (!norm) norm = 1;
  for (let i = 0; i < shifted.length; i++) shifted[i] /= norm;
  const profile = radialProfile(shifted, size, win);
  return { corrLenPx: firstBelowInvE(profile), profile: Array.from(profile.slice(0, 8)) };
}

// ---------------------------------------------------------------- 통계

function std(arr) {
  let mean = 0;
  for (let i = 0; i < arr.length; i++) mean += arr[i];
  mean /= arr.length;
  let ss = 0;
  for (let i = 0; i < arr.length; i++) { const d = arr[i] - mean; ss += d * d; }
  return Math.sqrt(ss / arr.length);
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

// ---------------------------------------------------------------- 퍼포레이션 캘리브레이션

const PERFORATION_PITCH_UM = 4750; // ISO 1007, 35mm 퍼포레이션 피치 4.75mm

// 상/하단 퍼포레이션 스트립에서 밝기 변화가 가장 큰 행을 찾고, 그 행에서
// 문턱값 교차로 구멍 시작 위치를 찾아 평균 간격을 잰다.
function findPerforationPitch(img) {
  const { width, height, data } = img;
  const bandHeight = Math.round(height * 0.12); // 상/하단 12%를 퍼포레이션 후보 영역으로
  const bands = [
    { name: "top", y0: 0, y1: bandHeight },
    { name: "bottom", y0: height - bandHeight, y1: height },
  ];

  const results = [];
  for (const band of bands) {
    let bestY = -1, bestStd = -1;
    // luminance = (R+G+B)/3, 행 단위 표준편차가 최대인 행이 구멍 경계를 가로지른다
    for (let y = band.y0; y < band.y1; y++) {
      const row = new Float64Array(width);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        row[x] = (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      const s = std(row);
      if (s > bestStd) { bestStd = s; bestY = y; }
    }
    if (bestY < 0) continue;
    const row = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const i = (bestY * width + x) * 3;
      row[x] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    let lo = Infinity, hi = -Infinity;
    for (let x = 0; x < width; x++) { if (row[x] < lo) lo = row[x]; if (row[x] > hi) hi = row[x]; }
    const mid = (lo + hi) / 2;
    const edges = [];
    for (let x = 1; x < width; x++) {
      if (row[x - 1] < mid && row[x] >= mid) edges.push(x); // 어두움→밝음(구멍 시작) 상승 엣지
    }
    if (edges.length < 2) continue;
    const spacings = [];
    for (let i = 1; i < edges.length; i++) spacings.push(edges[i] - edges[i - 1]);
    const meanSpacing = spacings.reduce((a, b2) => a + b2, 0) / spacings.length;
    const spacingStd = std(Float64Array.from(spacings));
    results.push({ band: band.name, row: bestY, edgesFound: edges.length, pitchPx: meanSpacing, pitchStdPx: spacingStd, firstEdgeX: edges[0] });
  }
  return results;
}

// 퍼포레이션 상승 엣지 하나로 채널별 간이 슬랜티드 엣지 PSF sigma를 잰다.
// ISO 12233 풀 SFR이 아니라 10-90% 폭 → sigma 근사(erf 10-90%↔sigma 계수 2.563)다.
function measurePSF(img, band) {
  if (!band) return null;
  const { width, data } = img;
  const y = band.row;
  const ex = band.firstEdgeX;
  const half = 20;
  const x0 = Math.max(0, ex - half), x1 = Math.min(width, ex + half);
  const sigmas = {};
  for (let c = 0; c < 3; c++) {
    // 그레인 잡음을 줄이려 엣지 주변 11행을 평균해 ESF를 뽑는다
    const esf = new Float64Array(x1 - x0);
    let rows = 0;
    for (let dy = -5; dy <= 5; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= img.height) continue;
      rows++;
      for (let x = x0; x < x1; x++) esf[x - x0] += data[(yy * width + x) * 3 + c];
    }
    for (let i = 0; i < esf.length; i++) esf[i] /= rows;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < esf.length; i++) { if (esf[i] < lo) lo = esf[i]; if (esf[i] > hi) hi = esf[i]; }
    const t10 = lo + 0.1 * (hi - lo), t90 = lo + 0.9 * (hi - lo);
    let x10 = null, x90 = null;
    for (let i = 1; i < esf.length; i++) {
      if (x10 === null && esf[i - 1] < t10 && esf[i] >= t10) {
        x10 = i - 1 + (t10 - esf[i - 1]) / (esf[i] - esf[i - 1]);
      }
      if (x90 === null && esf[i - 1] < t90 && esf[i] >= t90) {
        x90 = i - 1 + (t90 - esf[i - 1]) / (esf[i] - esf[i - 1]);
      }
    }
    sigmas["RGB"[c]] = x10 !== null && x90 !== null ? Math.abs(x90 - x10) / 2.563 : null;
  }
  return sigmas;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { files: [], size: 512, sigma: 8, out: null, patches: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--patch") {
      const [cy, cx] = argv[++i].split(",").map(Number);
      args.patches.push({ cy, cx });
    } else if (a === "--zone") {
      // --zone <이름>,<cy>,<cx> — 밀도 단계에 라벨을 붙인다 (G3용)
      const [label, cy, cx] = argv[++i].split(",");
      args.patches.push({ cy: Number(cy), cx: Number(cx), label });
    } else if (a === "--size") args.size = parseInt(argv[++i], 10);
    else if (a === "--sigma") args.sigma = parseFloat(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else args.files.push(a);
  }
  return args;
}

// 한 패치(밀도 단계 1곳)의 전 채널 측정. calibration/psf는 이미지 전체에서
// 한 번만 재 밀도 단계마다 재사용한다 — 광학은 프레임 안에서 안 바뀐다.
function measurePatch(imgA, imgB, patch, size, sigma, win, psf) {
  const y0 = patch.cy - size / 2, x0 = patch.cx - size / 2;
  if (y0 < 0 || x0 < 0 || y0 + size > imgA.height || x0 + size > imgA.width) {
    throw new Error(`패치가 이미지 밖: y0=${y0} x0=${x0} size=${size} image=${imgA.width}x${imgA.height}`);
  }

  const channels = ["R", "G", "B"];
  const patchesA = {}, highpassA = {};
  for (let c = 0; c < 3; c++) {
    patchesA[channels[c]] = cropChannel(imgA, c, y0, x0, size);
    highpassA[channels[c]] = highpass(patchesA[channels[c]], size, sigma);
  }

  const report = {
    label: patch.label || null,
    patch: { cy: patch.cy, cx: patch.cx },
    meanLevel: { R: mean(patchesA.R), G: mean(patchesA.G), B: mean(patchesA.B) },
    channels: {},
    crossChannelCorrelation: {},
  };

  for (const ch of channels) {
    report.channels[ch] = {
      rmsMeasured: std(highpassA[ch]),
      autoCorrLenPx: autoCorrLength(highpassA[ch], size, win).corrLenPx,
    };
  }
  report.crossChannelCorrelation = {
    RG: pearson(highpassA.R, highpassA.G),
    GB: pearson(highpassA.G, highpassA.B),
    RB: pearson(highpassA.R, highpassA.B),
  };

  if (imgB) {
    const patchesB = {}, highpassB = {};
    for (let c = 0; c < 3; c++) {
      patchesB[channels[c]] = cropChannel(imgB, c, y0, x0, size);
      highpassB[channels[c]] = highpass(patchesB[channels[c]], size, sigma);
    }
    report.sensorNoise = {};
    report.filmRms = {};
    for (const ch of channels) {
      const diff = new Float64Array(size * size);
      for (let i = 0; i < diff.length; i++) diff[i] = patchesA[ch][i] - patchesB[ch][i];
      const sigmaSensor = std(diff) / Math.SQRT2; // √2·σ_센서 = 차영상 표준편차 (그레인은 고정 패턴이라 상쇄)
      report.sensorNoise[ch] = sigmaSensor;
      const meas = report.channels[ch].rmsMeasured;
      report.filmRms[ch] = Math.sqrt(Math.max(meas * meas - sigmaSensor * sigmaSensor, 0));
      report.channels[ch].crossFrameCorrLenPx = crossCorrLength(highpassA[ch], highpassB[ch], size, win).corrLenPx;
    }
    const g = report.filmRms.G || 1;
    report.amplitudeRatio = { R: report.filmRms.R / g, G: 1, B: report.filmRms.B / g };

    const gLen = report.channels.G.crossFrameCorrLenPx;
    report.sizeRatio = {
      raw: { R: report.channels.R.crossFrameCorrLenPx / gLen, G: 1, B: report.channels.B.crossFrameCorrLenPx / gLen },
      caCorrected: null,
    };
    if (psf && psf.R != null && psf.G != null && psf.B != null) {
      // 상관길이에서 PSF를 구적으로 뺀다 (렌즈 흐림 ≠ 그레인 구조)
      const corr = (lenPx, sigmaPsf) => Math.sqrt(Math.max(lenPx * lenPx - sigmaPsf * sigmaPsf, 0));
      const rC = corr(report.channels.R.crossFrameCorrLenPx, psf.R);
      const gC = corr(report.channels.G.crossFrameCorrLenPx, psf.G);
      const bC = corr(report.channels.B.crossFrameCorrLenPx, psf.B);
      report.sizeRatio.caCorrected = { R: gC ? rC / gC : null, G: 1, B: gC ? bC / gC : null };
    }
  }

  return report;
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length < 1 || args.patches.length < 1) {
    console.error("사용법: node tools/measure-scan.js <a.ppm> [b.ppm] --patch <cy>,<cx> [--zone shadow,<cy>,<cx> ...] [--size 512] [--sigma 8] [--out out.json]");
    process.exit(1);
  }
  if ((Math.log2(args.size) % 1) !== 0) {
    console.error(`--size는 2의 거듭제곱이어야 한다 (FFT). 받은 값: ${args.size}`);
    process.exit(1);
  }

  const imgA = readPPM(args.files[0]);
  const imgB = args.files[1] ? readPPM(args.files[1]) : null;

  // 캘리브레이션·PSF는 프레임 전체 광학 조건이라 밀도 단계마다 한 번만 잰다
  const perforations = findPerforationPitch(imgA);
  const umPerPx = perforations.length
    ? PERFORATION_PITCH_UM / (perforations.reduce((s, p) => s + p.pitchPx, 0) / perforations.length)
    : null;
  const psf = perforations.length ? measurePSF(imgA, perforations[0]) : null;

  const win = Math.min(40, args.size / 4);
  const zones = args.patches.map((patch) => {
    try {
      return measurePatch(imgA, imgB, patch, args.size, args.sigma, win, psf);
    } catch (e) {
      return { label: patch.label || null, patch, error: e.message };
    }
  });

  const report = {
    input: { a: args.files[0], b: args.files[1] || null, size: args.size, highpassSigma: args.sigma },
    calibration: { umPerPx, perforations },
    psf,
    zones,
  };

  const json = JSON.stringify(report, null, 2);
  if (args.out) { fs.writeFileSync(args.out, json); console.error(`→ ${args.out}`); }
  else console.log(json);
}

main();
