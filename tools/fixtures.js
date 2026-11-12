/**
 * 검사용 합성 파일. 지금은 DNG 하나다.
 *
 * RAW 현상 검사에 진짜 카메라 파일을 쓰면 저장소에 수십 MB짜리 표본을 넣거나 검사가
 * 네트워크에 기대야 한다. DNG는 규격이 공개돼 있어 **손으로 쓸 수 있다** — 무압축
 * 베이어(RGGB) 한 장과 색 태그 몇 개면 LibRaw가 진짜 RAW로 읽는다. 값을 우리가
 * 정했으니 기대값도 계산으로 나온다(진짜 사진으로는 "그럴듯해 보인다"까지만 된다).
 *
 * 진짜 카메라 RAW와의 대조는 `tools/check-raw.py`가 rawpy로 따로 한다.
 */

/**
 * 무압축 16bit 베이어 DNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {(x:number, y:number) => [number, number, number]} scene  그 자리의 **카메라 선형**
 *        RGB(0~1, 화이트 레벨 기준). 화이트밸런스 전 값이 아니라 **중성이 r=g=b인** 값으로 준다 —
 *        아래에서 AsShotNeutral을 곱해 센서 값으로 바꾼다
 * @param {object} [opts]
 * @param {number[]} [opts.neutral]  AsShotNeutral. 기본 [0.5, 1, 0.7] — 화이트밸런스가 실제로 일하게
 * @param {number} [opts.baselineExposure]  스톱
 * @param {number} [opts.black] @param {number} [opts.white]
 */
function makeDng(width, height, scene, opts) {
  const o = opts || {};
  const neutral = o.neutral || [0.5, 1, 0.7];
  const black = o.black == null ? 512 : o.black;
  const white = o.white == null ? 16383 : o.white;
  const be = o.baselineExposure || 0;

  const cfa = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : (x & 1) === 0 ? 1 : 2; // RGGB
      const v = scene(x, y)[c] * neutral[c];
      cfa[y * width + x] = Math.max(0, Math.min(65535, Math.round(black + v * (white - black))));
    }
  }

  const ascii = (s) => Array.from(s + "\0", (ch) => ch.charCodeAt(0));
  const srat = (v) => [Math.round(v * 10000), 10000];
  // 카메라 = 선형 sRGB라고 치는 ColorMatrix1(XYZ D65 → 카메라). 이 행렬에서 D65 흰색의
  // 카메라 응답이 (1,1,1)이라 위의 "중성이 r=g=b" 약속이 성립한다
  const cm = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
  // [태그, 형, 값들]. 형: 1 BYTE · 2 ASCII · 3 SHORT · 4 LONG · 5 RATIONAL · 10 SRATIONAL
  const tags = [
    [254, 4, [0]], [256, 4, [width]], [257, 4, [height]], [258, 3, [16]], [259, 3, [1]],
    [262, 3, [32803]], [271, 2, ascii("FilmSim")], [272, 2, ascii("Synthetic DNG")],
    [273, 4, [0]], [274, 3, [1]], [277, 3, [1]], [278, 4, [height]], [279, 4, [cfa.length * 2]], [284, 3, [1]],
    [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]],
    [50706, 1, [1, 4, 0, 0]], [50707, 1, [1, 1, 0, 0]], [50708, 2, ascii("FilmSim Synthetic DNG")],
    [50714, 4, [black]], [50717, 4, [white]],
    [50721, 10, cm.flatMap(srat)], [50728, 5, neutral.flatMap((v) => [Math.round(v * 10000), 10000])],
    [50730, 10, srat(be)], [50778, 3, [21]],
  ];
  const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const count = (t) => (t[1] === 5 || t[1] === 10 ? t[2].length / 2 : t[2].length);
  let at = 8 + 2 + tags.length * 12 + 4;
  for (const t of tags) {
    const n = unit[t[1]] * count(t);
    if (n > 4) { t.off = at; at += n + (n & 1); }
  }
  const pixelsAt = at;
  tags.find((t) => t[0] === 273)[2] = [pixelsAt];

  const buf = new Uint8Array(pixelsAt + cfa.length * 2);
  const dv = new DataView(buf.buffer);
  buf[0] = buf[1] = 0x49;
  dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, tags.length, true);
  const put = (p, type, vals) => vals.forEach((v, k) => {
    if (type === 3) dv.setUint16(p + k * 2, v, true);
    else if (type === 4 || type === 5) dv.setUint32(p + k * 4, v, true);
    else if (type === 10) dv.setInt32(p + k * 4, v, true);
    else buf[p + k] = v;
  });
  tags.forEach((t, i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, t[0], true); dv.setUint16(e + 2, t[1], true); dv.setUint32(e + 4, count(t), true);
    put(t.off != null ? t.off : e + 8, t[1], t[2]);
    if (t.off != null) dv.setUint32(e + 8, t.off, true);
  });
  for (let i = 0; i < cfa.length; i++) dv.setUint16(pixelsAt + i * 2, cfa[i], true);
  return buf;
}

module.exports = { makeDng };
