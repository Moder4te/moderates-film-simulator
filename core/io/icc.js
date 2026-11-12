/**
 * ICC 프로파일 — **읽을 때는 이름만, 쓸 때는 ProPhoto 하나만.**
 *
 * 색 관리 엔진이 아니다. 독립 실행형(apps/studio)이 파일을 열 때 "이 코드값이 무슨
 * 색공간인가"를 알아야 하고(→ `core/render/working.js`가 작업 공간으로 옮긴다),
 * 16bit TIFF를 내보낼 때 ProPhoto라고 **적어 줘야** 한다. 그 둘만 한다.
 *
 * 왜 박는가는 `tools/decode-raw.py`의 `prophoto_icc`에 적혀 있다 — 안 박으면 받는
 * 쪽이 sRGB로 읽어 채도가 크게 빠져 보이고, 그게 "색이 틀렸다"는 오판으로 이어진다.
 * 여기는 그 함수의 JS판이고 **바이트 단위로 같은 구조**다(행렬 + 감마 1.8 `curv`).
 */

// ProPhoto(ROMM) 원색 → XYZ D50. tools/decode-raw.py와 같은 수.
const PROPHOTO_TO_XYZ_D50 = [
  [0.7976749, 0.1351917, 0.0313534],
  [0.2880402, 0.7118741, 0.0000857],
  [0.0, 0.0, 0.82521],
];
const D50 = [0.9642, 1.0, 0.8249];

function be32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function ascii(s) {
  return Array.from(s, (c) => c.charCodeAt(0));
}
function zeros(n) {
  return new Array(n).fill(0);
}
const s15 = (x) => be32(Math.round(x * 65536) | 0);

/** ProPhoto RGB ICC v2 디스플레이 프로파일(행렬 + 감마 1.8). */
function prophoto() {
  const xyz = (v) => [...ascii("XYZ "), ...zeros(4), ...s15(v[0]), ...s15(v[1]), ...s15(v[2])];
  // u8Fixed8 0x01CD = 1.8008 — Adobe `ProPhoto RGB` 프로파일과 같은 값
  const curv = [...ascii("curv"), ...zeros(4), ...be32(1), 0x01, 0xcd, 0, 0];
  const name = "ProPhoto RGB (FilmSim Studio)";
  const desc = [
    ...ascii("desc"), ...zeros(4), ...be32(name.length + 1), ...ascii(name), 0,
    ...zeros(8), ...zeros(3), ...zeros(67),
  ];
  const cprt = [...ascii("text"), ...zeros(4), ...ascii("No copyright, use freely"), 0];
  const col = (i) => PROPHOTO_TO_XYZ_D50.map((row) => row[i]);
  const tags = [
    ["desc", desc], ["cprt", cprt], ["wtpt", xyz(D50)],
    ["rXYZ", xyz(col(0))], ["gXYZ", xyz(col(1))], ["bXYZ", xyz(col(2))],
    ["rTRC", curv], ["gTRC", curv], ["bTRC", curv],
  ];
  const off = 128 + 4 + 12 * tags.length;
  const table = [];
  const data = [];
  for (const [sig, body] of tags) {
    const padded = body.concat(zeros((4 - (body.length % 4)) % 4)); // 태그는 4바이트 경계
    table.push(...ascii(sig), ...be32(off + data.length), ...be32(padded.length));
    data.push(...padded);
  }
  const size = off + data.length;
  const header = [
    ...be32(size), ...zeros(4), ...be32(0x02100000),
    ...ascii("mntrRGB XYZ "), ...zeros(12), ...ascii("acsp"), ...zeros(24),
    ...be32(0), ...s15(D50[0]), ...s15(D50[1]), ...s15(D50[2]), ...zeros(48),
  ];
  if (header.length !== 128) throw new Error("ICC 헤더 길이 오류");
  return Uint8Array.from([...header, ...be32(tags.length), ...table, ...data]);
}

/**
 * 프로파일 설명 문자열. 못 읽으면 null.
 * v2는 `desc`(ASCII), v4는 `mluc`(UTF-16BE) — 둘 다 본다.
 */
function describe(bytes) {
  try {
    if (!bytes || bytes.length < 132) return null;
    const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const count = u32(128);
    for (let i = 0; i < count; i++) {
      const e = 132 + i * 12;
      if (e + 12 > bytes.length) return null;
      const sig = String.fromCharCode(bytes[e], bytes[e + 1], bytes[e + 2], bytes[e + 3]);
      if (sig !== "desc") continue;
      const off = u32(e + 4);
      const type = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      if (type === "desc") {
        const n = u32(off + 8);
        let s = "";
        for (let k = 0; k < n - 1 && off + 12 + k < bytes.length; k++) s += String.fromCharCode(bytes[off + 12 + k]);
        return s;
      }
      if (type === "mluc") {
        const len = u32(off + 20);
        const at = off + u32(off + 24);
        let s = "";
        for (let k = 0; k + 1 < len && at + k + 1 < bytes.length; k += 2) {
          s += String.fromCharCode((bytes[at + k] << 8) | bytes[at + k + 1]);
        }
        return s;
      }
      return null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 프로파일 이름 → 우리가 아는 공간. 모르면 "unknown".
 * 이름으로 가르는 것은 `colorspace.workingSpaceCheck`와 같은 방식이다.
 */
function classify(name) {
  if (!name) return "unknown";
  if (/prophoto|romm/i.test(name)) return "prophoto";
  if (/adobe\s*rgb/i.test(name)) return "adobergb";
  if (/display\s*p3|dci.?p3|p3/i.test(name)) return "p3";
  if (/srgb/i.test(name)) return "srgb";
  return "unknown";
}

module.exports = { prophoto, describe, classify };
