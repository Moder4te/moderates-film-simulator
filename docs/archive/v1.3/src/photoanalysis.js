/**
 * 사진 색역 분석 — 컬러휠 마커를 실제 사진의 대표색으로 채운다.
 *
 * 활성 문서를 축소해 읽고, 각 픽셀을 Selective Color 색역으로 분류해 색역별
 * 대표색을 뽑는다. 컬러휠·색역 편집 구조와 1:1 대응하고, 필름 그레이딩(색역별
 * 발색)과 직결된다.
 *
 * 유채 색역은 채도 가중 평균 — 채도 높은 픽셀이 대표에 더 기여해 회색으로 흐려지지
 * 않고 그 색역의 선명한 방향을 대표한다. 무채 색역은 채도가 낮으므로 균등 평균.
 *
 * 세부 휠용으로 각 색역을 밝기 4구간으로도 세분해 대표를 낸다.
 *
 * 비용: 픽셀 1회 순회(누적 평균). k-means 같은 반복 없이 가볍다.
 */

const { app, imaging, core } = require("photoshop");
const colorwheel = require("./colorwheel");

const SAMPLE_WIDTH = 200; // 분석용 썸네일 가로 px
const TONE_BINS = 4; // 밝기 세분 구간 수

const CHROMA_BANDS = [
  ["reds", 0], ["yellows", 60], ["greens", 120],
  ["cyans", 180], ["blues", 240], ["magentas", 300],
];
const ALL_RANGES = [
  "reds", "yellows", "greens", "cyans", "blues", "magentas",
  "whites", "neutrals", "blacks",
];

/** 색을 색역으로 분류. main.js의 classifyRange와 동일 기준. */
function classify(h, s, v) {
  if (s < 0.22) {
    if (v > 0.7) return "whites";
    if (v < 0.35) return "blacks";
    return "neutrals";
  }
  let best = "reds";
  let bd = 999;
  for (const [name, bh] of CHROMA_BANDS) {
    let d = Math.abs(h - bh) % 360;
    if (d > 180) d = 360 - d;
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

function isChromatic(range) {
  return range !== "whites" && range !== "neutrals" && range !== "blacks";
}

function newBin() {
  const tones = [];
  for (let i = 0; i < TONE_BINS; i++) tones.push({ wr: 0, wg: 0, wb: 0, sw: 0, n: 0 });
  return { wr: 0, wg: 0, wb: 0, sw: 0, n: 0, tones };
}

function accumulate(bin, r, g, b, w) {
  bin.wr += r * w;
  bin.wg += g * w;
  bin.wb += b * w;
  bin.sw += w;
  bin.n++;
}

function repOf(bin) {
  if (bin.sw <= 0) return null;
  return [
    Math.round(bin.wr / bin.sw),
    Math.round(bin.wg / bin.sw),
    Math.round(bin.wb / bin.sw),
  ];
}

/**
 * 활성 문서를 분석해 색역별 대표색을 반환한다.
 * 반환: { ranges: { reds: {rep:[r,g,b]|null, weight:0~1, tones:[[r,g,b]|null x4]}, ... },
 *         total: 샘플 픽셀 수 } — 문서 없으면 null.
 */
async function analyze() {
  if (!app.documents.length) return null;
  const doc = app.activeDocument;
  let result = null;

  await core.executeAsModal(
    async () => {
      const px = await imaging.getPixels({
        documentID: doc.id,
        targetSize: { width: SAMPLE_WIDTH },
      });
      const w = px.imageData.width;
      const h = px.imageData.height;
      const comps = px.imageData.components;
      const data = await px.imageData.getData({ chunky: true });

      const bins = {};
      for (const r of ALL_RANGES) bins[r] = newBin();
      let total = 0;

      for (let i = 0; i < data.length; i += comps) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const hsv = colorwheel.rgbToHsv(r, g, b);
        const range = classify(hsv.h, hsv.s, hsv.v);
        // 유채 색역은 채도 가중(선명한 픽셀 우선), 무채 색역은 균등.
        const weight = isChromatic(range) ? hsv.s : 1;
        if (weight <= 0) continue;
        const bin = bins[range];
        accumulate(bin, r, g, b, weight);
        let t = Math.floor(hsv.v * TONE_BINS);
        if (t >= TONE_BINS) t = TONE_BINS - 1;
        if (t < 0) t = 0;
        accumulate(bin.tones[t], r, g, b, weight);
        total++;
      }

      const ranges = {};
      for (const name of ALL_RANGES) {
        const bin = bins[name];
        ranges[name] = {
          rep: repOf(bin),
          weight: total > 0 ? bin.n / total : 0,
          tones: bin.tones.map(repOf),
        };
      }
      result = { ranges, total };

      px.imageData.dispose();
    },
    { commandName: "사진 색 분석" }
  );

  return result;
}

module.exports = { analyze, ALL_RANGES, CHROMA_BANDS };
