/**
 * TIFF 읽기·쓰기 — 독립 실행형(apps/studio)이 16bit 파일을 주고받는 통로.
 *
 * 브라우저는 TIFF를 못 읽고, JPEG·PNG도 8bit로만 풀어 준다. 그런데 필름 엔진은
 * **16bit ProPhoto**를 전제로 한다(`docs/ARCHITECTURE.md` 「중립 현상」) — Camera Raw·
 * Lightroom·`tools/decode-raw.py`가 내는 파일이 전부 TIFF다. 그래서 직접 읽는다.
 *
 * ── 읽는 범위 ───────────────────────────────────────────────────────────
 *
 *   바이트 순서   II / MM
 *   비트          8 / 16  (정수만)
 *   색            RGB(+알파·여분 채널은 버린다) · 그레이(세 채널로 복제)
 *   배치          스트립 / 타일, 청키(PlanarConfiguration 1)
 *   압축          없음 · LZW · Deflate(ZIP) · PackBits
 *   예측자        없음 · 수평 차분(2)
 *
 * 범위 밖(BigTIFF·32bit float·채널 분리 저장·JPEG 압축·CMYK)은 **조용히 틀리게 읽지
 * 않고 이유를 적어 던진다.** 색이 틀린 채로 열리는 것이 못 여는 것보다 나쁘다.
 *
 * Deflate만 밖에서 받는다(`opts.inflate`) — 노드는 zlib, 브라우저는
 * DecompressionStream이라 둘 다 이 파일에 넣을 수 없다. 나머지는 순수 계산이다.
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, photometric: 262,
  stripOffsets: 273, orientation: 274, samples: 277, rowsPerStrip: 278,
  stripByteCounts: 279, planar: 284, predictor: 317,
  tileWidth: 322, tileLength: 323, tileOffsets: 324, tileByteCounts: 325,
  extraSamples: 338, sampleFormat: 339, icc: 34675,
};

function fail(msg) {
  const e = new Error(msg);
  e.unsupported = true;
  return e;
}

/** IFD 하나를 읽어 태그 → 값 배열 지도로 돌려준다. */
function readIfd(view, offset, le) {
  const n = view.getUint16(offset, le);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    const tag = view.getUint16(e, le);
    const type = view.getUint16(e + 2, le);
    const count = view.getUint32(e + 4, le);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const at = size * count <= 4 ? e + 8 : view.getUint32(e + 8, le);
    if (at + size * count > view.byteLength) continue; // 깨진 항목은 건너뛴다
    // ICC처럼 큰 바이트 덩어리는 값 배열로 풀지 않고 위치만 기억한다
    if (type === 7 || (type === 1 && count > 64)) {
      tags.set(tag, { bytesAt: at, count });
      continue;
    }
    const vals = new Array(count);
    for (let k = 0; k < count; k++) {
      const p = at + k * size;
      vals[k] =
        type === 3 ? view.getUint16(p, le)
        : type === 4 ? view.getUint32(p, le)
        : type === 1 || type === 2 || type === 6 ? view.getUint8(p)
        : type === 8 ? view.getInt16(p, le)
        : type === 9 ? view.getInt32(p, le)
        : type === 5 ? view.getUint32(p, le) / (view.getUint32(p + 4, le) || 1)
        : 0;
    }
    tags.set(tag, vals);
  }
  return tags;
}

/**
 * TIFF LZW — GIF와 달리 **MSB부터** 읽고, 코드 폭을 한 코드 **일찍** 늘린다
 * ("early change"). 256 = 표 비우기, 257 = 끝.
 */
function lzwDecode(src, expected) {
  const out = new Uint8Array(expected);
  // 사전: 각 코드는 (앞 코드, 끝 바이트)로 저장하고 길이를 따로 둔다 — 문자열을
  // 실제로 만들지 않고 뒤에서부터 풀어 쓴다.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; length[i] = 1; }

  let next = 258, width = 9, bitPos = 0, o = 0, prev = -1;
  const totalBits = src.length * 8;
  while (bitPos + width <= totalBits && o < expected) {
    // 코드 하나 — 최대 12비트라 3바이트 안에 든다
    const byte = bitPos >> 3;
    const chunk = (src[byte] << 16) | ((src[byte + 1] || 0) << 8) | (src[byte + 2] || 0);
    const code = (chunk >> (24 - (bitPos & 7) - width)) & ((1 << width) - 1);
    bitPos += width;

    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }

    let entry = code;
    if (prev === -1) {
      if (code >= 256) throw new Error("TIFF LZW: 표를 비운 직후 코드가 문자가 아닙니다");
    } else {
      if (code > next) throw new Error("TIFF LZW: 사전에 없는 코드");
      // 새 항목 = 이전 문자열 + (이번 문자열의 첫 바이트). 이번 코드가 아직 사전에
      // 없으면(code === next) 그 첫 바이트는 이전 문자열의 첫 바이트다.
      let first = code === next ? prev : code;
      while (prefix[first] !== -1) first = prefix[first];
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = suffix[first];
        length[next] = length[prev] + 1;
        next++;
      }
      entry = code;
    }

    const len = length[entry];
    let p = o + len - 1;
    for (let c = entry; c !== -1; c = prefix[c], p--) if (p < expected) out[p] = suffix[c];
    o += len;
    prev = code;

    if (next >= 4095) width = 12; // 사전이 차면 12비트에 머문다(다음은 256)
    else if (next >= 2047) width = 12;
    else if (next >= 1023) width = 11;
    else if (next >= 511) width = 10;
  }
  return out;
}

function packBitsDecode(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = src[i++] << 24 >> 24; // int8
    if (n >= 0) {
      for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v;
    }
  }
  return out;
}

/**
 * TIFF를 푼다.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {object} [opts]
 * @param {(bytes:Uint8Array)=>Uint8Array|Promise<Uint8Array>} [opts.inflate]  zlib 스트림 풀기
 * @returns {Promise<{width:number, height:number, bits:8|16,
 *   data:Uint8Array|Uint16Array, icc:Uint8Array|null, gray:boolean}>}
 *   data는 RGB 인터리브(w·h·3). 16bit는 0~65535 그대로다
 */
async function decode(input, opts) {
  const o = opts || {};
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw fail("TIFF가 아닙니다 (너무 짧음)");

  const bo = String.fromCharCode(bytes[0], bytes[1]);
  if (bo !== "II" && bo !== "MM") throw fail("TIFF가 아닙니다 (바이트 순서 표시 없음)");
  const le = bo === "II";
  const magic = view.getUint16(2, le);
  if (magic === 43) throw fail("BigTIFF는 지원하지 않습니다 — 일반 TIFF로 다시 저장하세요");
  if (magic !== 42) throw fail("TIFF가 아닙니다");

  const tags = readIfd(view, view.getUint32(4, le), le);
  const one = (id, dflt) => (tags.has(id) && Array.isArray(tags.get(id)) ? tags.get(id)[0] : dflt);
  const list = (id) => (Array.isArray(tags.get(id)) ? tags.get(id) : null);

  const width = one(TAG.width);
  const height = one(TAG.height);
  if (!(width > 0) || !(height > 0)) throw fail("TIFF: 크기 태그가 없습니다");

  const bitsList = list(TAG.bits) || [1];
  const bits = bitsList[0];
  if (bitsList.some((b) => b !== bits) || (bits !== 8 && bits !== 16)) {
    throw fail(`TIFF: 채널당 ${bitsList.join("/")}비트는 지원하지 않습니다 (8 또는 16비트 정수만)`);
  }
  if (one(TAG.sampleFormat, 1) !== 1) {
    throw fail("TIFF: 부동소수점·부호 있는 샘플은 지원하지 않습니다 — 16비트 정수로 저장하세요");
  }
  const samples = one(TAG.samples, 1);
  const photometric = one(TAG.photometric, samples >= 3 ? 2 : 1);
  if (!((photometric === 2 && samples >= 3) || ((photometric === 1 || photometric === 0) && samples >= 1))) {
    throw fail(`TIFF: 색 모드(PhotometricInterpretation ${photometric}, 채널 ${samples})를 지원하지 않습니다 — RGB로 저장하세요`);
  }
  if (samples > 1 && one(TAG.planar, 1) !== 1) {
    throw fail("TIFF: 채널 분리 저장(Per Channel)은 지원하지 않습니다 — 인터리브(Interleaved)로 저장하세요");
  }
  const compression = one(TAG.compression, 1);
  if (![1, 5, 8, 32946, 32773].includes(compression)) {
    throw fail(`TIFF: 압축 방식 ${compression}을 지원하지 않습니다 — 없음·LZW·ZIP 중 하나로 저장하세요`);
  }
  const predictor = one(TAG.predictor, 1);
  if (predictor !== 1 && predictor !== 2) throw fail(`TIFF: 예측자 ${predictor}을 지원하지 않습니다`);

  const tiled = tags.has(TAG.tileOffsets);
  const offsets = list(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = list(tiled ? TAG.tileByteCounts : TAG.stripByteCounts);
  if (!offsets || !counts || offsets.length !== counts.length) throw fail("TIFF: 픽셀 위치 태그가 없습니다");
  const blockW = tiled ? one(TAG.tileWidth) : width;
  const blockH = tiled ? one(TAG.tileLength) : Math.min(one(TAG.rowsPerStrip, height), height);
  if (!(blockW > 0) || !(blockH > 0)) throw fail("TIFF: 블록 크기 태그가 없습니다");

  const bps = bits / 8;
  const gray = photometric !== 2;
  const invert = photometric === 0;
  const maxV = bits === 16 ? 65535 : 255;
  const out = bits === 16 ? new Uint16Array(width * height * 3) : new Uint8Array(width * height * 3);
  const across = tiled ? Math.ceil(width / blockW) : 1;

  for (let b = 0; b < offsets.length; b++) {
    const bx = (b % across) * blockW;
    const by = Math.floor(b / across) * blockH;
    if (by >= height) break;
    // 스트립은 마지막 것이 짧고, 타일은 항상 꽉 찬 크기로 저장된다
    const rows = tiled ? blockH : Math.min(blockH, height - by);
    const rawLen = blockW * rows * samples * bps;
    const src = bytes.subarray(offsets[b], offsets[b] + counts[b]);

    let raw;
    if (compression === 1) raw = src;
    else if (compression === 5) raw = lzwDecode(src, rawLen);
    else if (compression === 32773) raw = packBitsDecode(src, rawLen);
    else {
      if (!o.inflate) throw fail("TIFF: ZIP 압축을 풀 수단이 없습니다");
      raw = await o.inflate(src);
    }
    if (raw.length < rawLen) throw fail("TIFF: 픽셀 데이터가 잘렸습니다");

    const useRows = Math.min(rows, height - by);
    const useCols = Math.min(blockW, width - bx);
    const prev = new Uint32Array(samples);
    for (let y = 0; y < useRows; y++) {
      let p = y * blockW * samples * bps;
      let q = ((by + y) * width + bx) * 3;
      prev.fill(0);
      // 예측자는 블록의 **전체 폭**에 걸려 있다 — 타일 오른쪽 여백까지 누적해야 한다
      for (let x = 0; x < blockW; x++) {
        for (let s = 0; s < samples; s++, p += bps) {
          let v = bps === 1 ? raw[p] : le ? raw[p] | (raw[p + 1] << 8) : (raw[p] << 8) | raw[p + 1];
          if (predictor === 2) { v = (v + prev[s]) & maxV; prev[s] = v; }
          if (x >= useCols) continue;
          if (gray) {
            if (s === 0) { const g = invert ? maxV - v : v; out[q] = g; out[q + 1] = g; out[q + 2] = g; }
          } else if (s < 3) out[q + s] = v;
        }
        if (x < useCols) q += 3;
      }
    }
  }

  let icc = null;
  const iccTag = tags.get(TAG.icc);
  if (iccTag && iccTag.bytesAt != null) icc = bytes.slice(iccTag.bytesAt, iccTag.bytesAt + iccTag.count);
  return { width, height, bits, data: out, icc, gray };
}

/**
 * 쓰기 — 무압축 RGB 한 스트립. **머리만** 만든다.
 *
 * 픽셀은 호출자가 머리 뒤에 그대로 이어 붙인다(16bit는 리틀엔디언). 큰 이미지를
 * 띠로 나눠 구우면서 `Blob` 조각으로 넘기려는 것이라, 픽셀 전체를 한 덩어리로 다시
 * 복사하지 않는다. 60MP 16bit면 그 한 번이 360MB다.
 *
 * @param {{width:number, height:number, bits:8|16, icc?:Uint8Array}} meta
 * @returns {Uint8Array} 헤더 + IFD + ICC. 이 길이가 곧 픽셀 시작 위치다
 */
function header(meta) {
  const { width, height, bits } = meta;
  if (bits !== 8 && bits !== 16) throw new Error("TIFF 쓰기: 8 또는 16비트만");
  const icc = meta.icc || null;
  const pixelBytes = width * height * 3 * (bits / 8);
  if (pixelBytes > 0xfff00000) throw new Error("TIFF 쓰기: 4GB를 넘는 이미지는 쓸 수 없습니다");

  const entries = [
    [TAG.width, 4, [width]],
    [TAG.height, 4, [height]],
    [TAG.bits, 3, [bits, bits, bits]],
    [TAG.compression, 3, [1]],
    [TAG.photometric, 3, [2]],
    [TAG.stripOffsets, 4, [0]], // 아래에서 채운다
    [TAG.orientation, 3, [1]],
    [TAG.samples, 3, [3]],
    [TAG.rowsPerStrip, 4, [height]],
    [TAG.stripByteCounts, 4, [pixelBytes]],
    [TAG.planar, 3, [1]],
  ];
  if (icc) entries.push([TAG.icc, 7, icc]);

  const ifdAt = 8;
  const ifdLen = 2 + entries.length * 12 + 4;
  let extraAt = ifdAt + ifdLen;
  for (const e of entries) {
    const size = TYPE_SIZE[e[1]] * e[2].length;
    // (`e.at`은 못 쓴다 — 배열의 내장 메서드라 항상 값이 있다)
    if (size > 4) { e.offset = extraAt; extraAt += size + (size & 1); }
  }
  const total = extraAt;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; // II
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, entries.length, true);

  const put = (at, type, vals) => {
    for (let k = 0; k < vals.length; k++) {
      if (type === 3) dv.setUint16(at + k * 2, vals[k], true);
      else if (type === 4) dv.setUint32(at + k * 4, vals[k], true);
      else buf[at + k] = vals[k];
    }
  };
  entries.forEach((e, i) => {
    const at = ifdAt + 2 + i * 12;
    dv.setUint16(at, e[0], true);
    dv.setUint16(at + 2, e[1], true);
    dv.setUint32(at + 4, e[2].length, true);
    if (e[0] === TAG.stripOffsets) dv.setUint32(at + 8, total, true);
    else if (e.offset != null) { dv.setUint32(at + 8, e.offset, true); put(e.offset, e[1], e[2]); }
    else put(at + 8, e[1], e[2]);
  });
  return buf;
}

/** 편의 — 픽셀까지 한 덩어리로. 작은 이미지·검사용이다. */
function encode(meta, data) {
  const head = header(meta);
  const bps = meta.bits / 8;
  const out = new Uint8Array(head.length + data.length * bps);
  out.set(head);
  if (bps === 1) out.set(data, head.length);
  else {
    const dv = new DataView(out.buffer);
    for (let i = 0; i < data.length; i++) dv.setUint16(head.length + i * 2, data[i], true);
  }
  return out;
}

module.exports = { decode, header, encode, lzwDecode, packBitsDecode };
