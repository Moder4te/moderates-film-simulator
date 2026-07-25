/**
 * ACR Look 프로파일 XMP를 쓰는 데 필요한 저수준 코덱 — md5 / zlib / Adobe Base85.
 *
 * 왜 직접 구현하는가. UXP에는 압축도 해시도 없다. 그리고 이 저장소에는 번들러가
 * 없어서(package.json 자체가 없다) npm 의존성을 넣으려면 파일을 통째로 벤더링해야
 * 한다. 세 가지 다 짧아서 직접 쓰는 편이 낫다.
 *
 * 포맷 근거는 v2plan 7.5에 있다. 실측으로 규명했고 재현 검증까지 마쳤다.
 */

// ── md5 ────────────────────────────────────────────────────────────────
//
// 테이블 ID가 `md5(압축 해제 바이너리)`의 대문자 16진수다. 파일 3개에서 확인했다.
// ID가 틀리면 `crs:RGBTable`과 `crs:Table_<ID>`가 어긋나 프로파일이 무시된다.

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

/** @param {Uint8Array} bytes @returns {string} 대문자 16진수 32자 */
function md5(bytes) {
  const len = bytes.length;
  // 0x80 + 0패딩 + 길이 8바이트가 64의 배수가 되도록
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;

  // 비트 길이를 리틀엔디언 64비트로. len이 2^29를 넘으면 상위워드가 필요하다.
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 536870912), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }

      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, MD5_S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  let out = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) {
      out += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return out.toUpperCase();
}

// ── zlib ───────────────────────────────────────────────────────────────

/** adler32. 5552바이트마다 나머지를 취하면 32비트 누적이 넘치지 않는다. */
function adler32(bytes) {
  let a = 1, b = 0;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return (((b << 16) | a) >>> 0);
}

/**
 * 무압축(stored) zlib 스트림. 규격상 완전히 유효하다.
 *
 * DEFLATE의 BTYPE=00 블록은 "이 데이터를 그대로 담는다"는 뜻이고, 어떤 해제기든
 * 받아들인다. 실제 압축(LZ77 + 허프만)을 구현하지 않는 대신 외부 의존성이 0이다.
 *
 * 비용은 파일 크기뿐이다. 실측에서 ACR이 만든 테이블의 압축률은 196652 → 177943,
 * 즉 **1.105배**에 불과했다(부드러운 uint16이라 잘 줄지 않는다). 무압축으로 가면
 * 약 10% 커진다. 프로파일 하나가 250KB 남짓이 되는 정도라 문제되지 않는다.
 *
 * 크기가 문제가 되면 pako를 벤더링해 이 함수만 갈아끼우면 된다 — 나머지 코드는
 * 압축 방식을 모른다.
 */
function zlibStored(bytes) {
  const MAX = 65535; // stored 블록 한 개의 최대 길이
  const blocks = Math.max(1, Math.ceil(bytes.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
  let p = 0;

  // CMF=0x78 (deflate, 32K 윈도), FLG=0x01 → (0x78<<8|0x01) % 31 === 0
  out[p++] = 0x78;
  out[p++] = 0x01;

  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const n = Math.min(MAX, bytes.length - start);
    out[p++] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00
    out[p++] = n & 0xff;
    out[p++] = (n >>> 8) & 0xff;
    out[p++] = ~n & 0xff;
    out[p++] = (~n >>> 8) & 0xff;
    out.set(bytes.subarray(start, start + n), p);
    p += n;
  }

  const ad = adler32(bytes);
  out[p++] = (ad >>> 24) & 0xff; // adler는 빅엔디언이다
  out[p++] = (ad >>> 16) & 0xff;
  out[p++] = (ad >>> 8) & 0xff;
  out[p++] = ad & 0xff;

  return out.subarray(0, p);
}

// ── Adobe Base85 ───────────────────────────────────────────────────────

/**
 * Z85에서 XML 위험문자 `&` `<` `>` 세 개만 각각 `` ` `` `'` `|` 로 치환한 것.
 * 나머지 82자는 Z85와 순서까지 같다.
 */
const B85 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  ".-:+=^!/*?" + "`'|" + "()[]{}@%$#";

/**
 * 4바이트 → 5자.
 *
 * **방향이 표준 Z85와 반대다.** 4바이트를 **리틀엔디언** uint32로 읽고, 85로 나눈
 * 나머지를 **최하위 자리부터** 내보낸다. Z85는 빅엔디언 + 최상위 우선이다.
 * 이 방향을 표준으로 착각해서 해독이 한참 막혔다(v2plan 7.5).
 *
 * 끝에 4바이트가 안 남으면 0으로 채우고 `남은바이트+1`자만 쓴다. 최하위 우선이라
 * 상위 자리를 잘라내도 하위 바이트는 온전하다.
 */
function base85(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const k = Math.min(4, bytes.length - i);
    // 리틀엔디언: bytes[i]가 최하위. 2^32까지는 double로 정확하다.
    let x = 0;
    for (let j = 3; j >= 0; j--) x = x * 256 + (i + j < bytes.length ? bytes[i + j] : 0);
    const n = k === 4 ? 5 : k + 1;
    let s = "";
    for (let j = 0; j < n; j++) {
      s += B85[x % 85];
      x = Math.floor(x / 85);
    }
    parts.push(s);
  }
  return parts.join("");
}

/** 검증·시험용 역변환. 내보내기 경로에서는 쓰지 않는다. */
function base85Decode(text) {
  const V = new Map();
  for (let i = 0; i < B85.length; i++) V.set(B85[i], i);
  const out = [];
  for (let i = 0; i < text.length; i += 5) {
    const g = text.slice(i, i + 5);
    let x = 0;
    for (let j = g.length - 1; j >= 0; j--) {
      const v = V.get(g[j]);
      if (v === undefined) throw new Error(`base85: 알 수 없는 문자 ${g[j]}`);
      x = x * 85 + v;
    }
    x = x % 4294967296;
    const n = g.length === 5 ? 4 : g.length - 1;
    for (let j = 0; j < n; j++) out.push((x / Math.pow(256, j)) & 0xff);
  }
  return new Uint8Array(out);
}

/**
 * 문자열 → UTF-8 바이트.
 *
 * `TextEncoder`를 쓰지 않는다. UXP 버전에 따라 전역에 없을 수 있고, 없으면
 * 예외가 파일 생성 루프 안에서 터져 "전부 실패"로만 보인다. 직접 쓰면 그 위험이
 * 사라진다. 서로게이트 쌍(이모지 등)까지 처리한다.
 */
function utf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

module.exports = { md5, adler32, zlibStored, base85, base85Decode, utf8, B85 };
