/**
 * 사진 색 분석의 집계 계층 — 순수 함수.
 *
 * 픽셀을 받아 색역별로 누적하고 대표색을 낸다. 문서도 UXP도 모르므로 **노드에서
 * 합성 픽셀을 넣어 그대로 시험할 수 있다.**
 *
 * 그것이 이 파일을 분리한 이유다. 이전에는 픽셀 읽기와 집계가 한 함수에 섞여 있어
 * 실기에서만 확인할 수 있었고, 그래서 16bit·색공간 버그가 컬러휠 마커가 한 점으로
 * 뭉치고 나서야 드러났다.
 *
 * **입력은 sRGB 0~255다.** 심도 정규화와 색공간 변환은 호출자(어댑터)가 마친 뒤
 * 넘긴다. 여기서 하지 않는 이유는, 그러려면 문서 프로파일을 알아야 하고 그 순간
 * 순수하지 않게 되기 때문이다.
 */

const gamut = require("./gamut");

const TONE_BINS = 4; // 세부 휠용 밝기 구간 수

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

/** 가중 평균. 표본이 없으면 null — 호출자가 폴백을 쓴다. */
function repOf(bin) {
  if (bin.sw <= 0) return null;
  return [
    Math.round(bin.wr / bin.sw),
    Math.round(bin.wg / bin.sw),
    Math.round(bin.wb / bin.sw),
  ];
}

/**
 * 색역별 누적기.
 *
 *     const store = analysis.createStore();
 *     store.add(r, g, b);        // sRGB 0~255
 *     const result = store.result();
 */
function createStore() {
  const bins = {};
  for (const name of gamut.ALL_RANGES) bins[name] = newBin();
  let total = 0;

  return {
    /**
     * 픽셀 하나를 누적한다.
     *
     * 유채 색역은 **채도 가중** — 선명한 픽셀이 대표에 더 기여해, 그 색역에
     * 애매하게 걸친 저채도 픽셀이 대표를 회색으로 흐리지 않는다. 무채 색역은
     * 채도가 낮은 것이 정의이므로 균등 가중.
     */
    add(r, g, b) {
      const hsv = gamut.rgbToHsv(r, g, b);
      const range = gamut.classify(hsv.h, hsv.s, hsv.v);
      const weight = gamut.isChromatic(range) ? hsv.s : 1;
      if (weight <= 0) return;

      const bin = bins[range];
      accumulate(bin, r, g, b, weight);

      let t = Math.floor(hsv.v * TONE_BINS);
      if (t >= TONE_BINS) t = TONE_BINS - 1;
      if (t < 0) t = 0;
      accumulate(bin.tones[t], r, g, b, weight);
      total++;
    },

    result() {
      const ranges = {};
      for (const name of gamut.ALL_RANGES) {
        const bin = bins[name];
        ranges[name] = {
          rep: repOf(bin),
          weight: total > 0 ? bin.n / total : 0,
          tones: bin.tones.map(repOf),
        };
      }
      return { ranges, total };
    },
  };
}

module.exports = { createStore, newBin, accumulate, repOf, TONE_BINS };
