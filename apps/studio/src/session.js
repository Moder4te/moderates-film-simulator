/**
 * 세션 — 연 파일 하나를 쥐고 미리보기·내보내기를 해 준다.
 *
 * **환경을 모른다.** 브라우저에만 있는 것(이미지 디코드·캔버스 인코드·zlib)은 `env`로
 * 받는다. 그래서 같은 코드가 워커에서도, 워커를 못 쓰는 곳의 메인 스레드에서도,
 * 노드 검사(`tools/check-studio.js`)에서도 돈다.
 *
 *   env.inflate(bytes)              → Promise<Uint8Array>   zlib 풀기(TIFF ZIP 압축)
 *   env.rawWasm()                   → Uint8Array            RAW 현상부(LibRaw WebAssembly)
 *   env.decodeBitmap(bytes, type)   → Promise<{width,height,rgba}>  sRGB 8bit RGBA
 *   env.canvasEncoder(width,height) → { put(rgba,y,rows), finish(type,quality) → Promise<Blob> }
 *   env.blob(parts, type)           → Blob
 *   env.progress(label, fraction)   진행 표시(선택)
 */

const tiff = require("../../../core/io/tiff");
const icc = require("../../../core/io/icc");
const rawdecoder = require("../../../core/io/rawdecoder");
const cube = require("../../../core/io/cube");
const xmp = require("../../../core/io/xmp");
const working = require("../../../core/render/working");
const pipeline = require("../../../core/render/pipeline");

/** 미리보기 대리본의 긴 변. 화면용이라 이 이상은 느려지기만 한다. */
const PROXY_EDGE = 1600;
/**
 * 슬라이더를 **끄는 동안** 쓰는 초안 대리본의 비율. 화소가 1/4이라 네 배 빠르다 —
 * 1600px 전 단계가 데스크톱에서 0.5초대인데, 폰은 그 몇 배다. 손을 떼면 본 대리본으로
 * 다시 굽는다.
 */
const DRAFT_RATIO = 0.5;

function isTiff(b) {
  return b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42));
}

function createSession(env) {
  let full = null; // { width, height, data } 작업 공간
  let proxy = null;
  let draft = null;
  let info = null;
  let raw = null; // RAW 현상기 — 처음 RAW를 열 때 만든다(모듈 컴파일이 수십 ms)
  const cache = { lut: new Map(), halo: new Map() };
  const progress = (label, f) => env.progress && env.progress(label, f);

  // 필름 LUT은 슬라이더 하나 움직일 때마다 다시 구울 필요가 없다 — 마감 쪽을 만지는
  // 동안은 같은 표다. 몇 장만 들고 있는다.
  function lutCache(key, build) {
    if (cache.lut.has(key)) return cache.lut.get(key);
    const t = build();
    if (cache.lut.size >= 4) cache.lut.delete(cache.lut.keys().next().value);
    cache.lut.set(key, t);
    return t;
  }

  /**
   * RAW·DNG를 **플랫 현상**한다 — 톤 커브 없이, 화이트 레벨 기준 선형으로.
   *
   * `half`: true/false면 그대로. "auto"면 원본 크기로 풀되 두 경우에 절반으로 간다 —
   * 센서 화소 수가 `halfAbove`를 넘거나(폰에서 6천만 화소 원본은 풀다가 탭이 죽는다.
   * 한도는 화면 쪽이 기기를 보고 정해 넘긴다), 풀다가 메모리가 모자라면.
   */
  function developRaw(bytes, half, halfAbove) {
    if (!env.rawWasm) throw new Error("이 빌드에는 RAW 현상부가 들어 있지 않습니다");
    if (!raw) raw = rawdecoder.createRawDecoder(env.rawWasm());
    if (half !== "auto") return raw.decode(bytes, { half: !!half });
    try {
      return raw.decode(bytes, { half: false, halfAbove: halfAbove || 0 });
    } catch (e) {
      if (!e.outOfMemory) throw e;
      progress("메모리가 모자라 절반 크기로 다시 현상", 0);
      return raw.decode(bytes, { half: true });
    }
  }

  /**
   * 파일을 연다. 무엇이든 **작업 공간으로 옮겨서** 든다(`core/render/working.js`).
   * @returns 원본 정보 — 화면에 보여 주고 `pipeline.advise`에 넘긴다
   */
  async function open(buffer, name, type, opts) {
    const proxyEdge = Math.max(512, Math.min(PROXY_EDGE, (opts && opts.proxyEdge) || PROXY_EDGE));
    const bytes = new Uint8Array(buffer);
    let width, height, bits, space, assumed = false, profile = null, data, kind, rawInfo = null;

    // RAW는 **이름으로** 가른다. DNG·ARW·NEF·CR2는 TIFF 구조라 내용만 보면 TIFF다 —
    // 그대로 TIFF로 읽으면 안에 든 작은 미리보기가 열린다
    if (rawdecoder.isRawName(name)) {
      progress("RAW 현상 중", 0);
      const r = developRaw(bytes, opts && opts.rawHalf != null ? opts.rawHalf : "auto", opts && opts.rawHalfAbove);
      width = r.width; height = r.height; bits = 16; space = "prophoto"; kind = "RAW";
      data = r.data;
      rawInfo = {
        make: r.make, model: r.model, dng: r.dng, half: r.half,
        baselineExposure: r.baselineExposure, clippedPercent: r.clippedPercent,
      };
      const cam = [r.make, r.model].filter(Boolean).join(" ");
      profile = `RAW 플랫 현상${r.half ? " (절반 크기)" : ""}${cam ? " · " + cam : ""}`;
    } else if (isTiff(bytes)) {
      progress("파일 여는 중", 0);
      const t = await tiff.decode(bytes, { inflate: env.inflate });
      width = t.width; height = t.height; bits = t.bits; kind = "TIFF";
      profile = t.icc ? icc.describe(t.icc) : null;
      space = icc.classify(profile);
      if (space === "unknown" || space === "p3") {
        // 프로파일이 없거나 모르는 것 — 16bit TIFF는 이 도구의 정상 입력(ProPhoto
        // 현상본)일 가능성이 높고, 8bit는 sRGB일 가능성이 높다. 가정했다고 알린다
        space = bits === 16 ? "prophoto" : "srgb";
        assumed = true;
      }
      data = working.toWorking(t.data, 3, width * height, space);
    } else {
      progress("파일 여는 중", 0);
      const bm = await env.decodeBitmap(bytes, type);
      width = bm.width; height = bm.height; bits = 8; space = "srgb"; kind = "8bit";
      profile = "sRGB (브라우저가 변환)";
      data = working.toWorking(bm.rgba, 4, width * height, "srgb");
    }

    full = { width, height, data };
    const ps = working.fitSize(width, height, proxyEdge);
    proxy = working.resize(full, ps.width, ps.height);
    const ds = working.fitSize(proxy.width, proxy.height, Math.round(Math.max(proxy.width, proxy.height) * DRAFT_RATIO));
    draft = working.resize(proxy, ds.width, ds.height);
    cache.halo.clear();
    info = { name, width, height, bits, space, assumed, profile, kind, raw: rawInfo, proxy: { width: proxy.width, height: proxy.height } };
    return info;
  }

  function requireOpen() {
    if (!full) throw new Error("열린 이미지가 없습니다");
  }

  /** 대리본에서 구한 할레이션 필드. 그레인만 바꾼 동안은 다시 구하지 않는다. */
  function proxyHalo(params, img, pl) {
    const key = pipeline.haloKey(params);
    if (!key) return null;
    const hit = cache.halo.get(img);
    if (hit && hit.key === key) return hit.field;
    const field = pipeline.haloField(img, pl);
    cache.halo.set(img, { key, field });
    return field;
  }

  /**
   * 화면용 렌더.
   *
   * @param {object} params
   * @param {object} view
   *   { mode: "fit" }                       대리본 전체
   *   { mode: "crop", x, y, w, h }          원본 해상도의 사각형(1:1 보기)
   *   original: true                        아무 단계도 걸지 않은 원본
   *   draft: true                           초안 대리본으로(끄는 동안. 맞춤 보기만)
   * @returns {{width,height,rgba:Uint8ClampedArray,ms:number,warnings:string[], view}}
   */
  function preview(params, view) {
    requireOpen();
    const t0 = Date.now();
    const blank = { film: { enabled: false }, grading: { enabled: false } };
    const p = view.original ? blank : params;
    // 미리보기는 33³로 굽는다 — 65³와의 차이는 화면에서 안 보이고 굽는 시간은 8배다
    const opts = { lutSize: 33, lutCache };

    let src, pl, region, halo;
    if (view.mode === "crop") {
      src = full;
      pl = pipeline.plan(p, full, full, opts);
      const w = Math.min(view.w, full.width), h = Math.min(view.h, full.height);
      const x = Math.max(0, Math.min(full.width - w, Math.round(view.x)));
      const y = Math.max(0, Math.min(full.height - h, Math.round(view.y)));
      region = { x, y, w, h };
      // 번짐 필드는 대리본 것을 빌린다. 원본 해상도로 다시 구하면 슬라이더마다 전체를
      // 한 번 훑어야 한다. 내보낼 때는 정확히 다시 구한다(`exportImage`)
      halo = view.original ? null : proxyHalo(params, proxy, pipeline.plan(p, full, proxy, opts));
    } else {
      src = view.draft ? draft : proxy;
      pl = pipeline.plan(p, full, src, opts);
      region = { x: 0, y: 0, w: src.width, h: src.height };
      halo = view.original ? null : proxyHalo(params, src, pl);
    }

    const buf = pipeline.renderRegion(src, pl, region, halo);
    const rgba = new Uint8ClampedArray(region.w * region.h * 4);
    working.toSRGB8(buf, region.w, region.h, region.x, region.y, pl.W, rgba, pl.active);
    return {
      width: region.w, height: region.h, rgba,
      ms: Date.now() - t0,
      warnings: view.original ? [] : pipeline.advise(params, info),
      view: Object.assign({}, view, region),
    };
  }

  /**
   * 원본 해상도로 굽어 파일로 낸다.
   *
   * @param {object} params
   * @param {{format:"jpeg"|"png"|"tiff16", quality?:number, longEdge?:number, flat?:boolean}} opts
   *   flat: 아무 단계도 걸지 않고 낸다 — RAW를 열었으면 그게 곧 **플랫 현상본**이다
   *   (`tools/decode-raw.py`가 내는 파일과 같은 것. Photoshop 엔진에 「리니어 +N스톱」으로 먹인다)
   * @returns {Promise<{blob:Blob, ext:string, width:number, height:number}>}
   */
  async function exportImage(params, opts) {
    requireOpen();
    const o = opts || {};
    const size = working.fitSize(full.width, full.height, o.longEdge);
    // 줄여서 내보내면 **그 크기가 곧 문서다** — 입자·번짐을 그 크기 기준으로 다시 잡는다.
    // 원본에서 굽고 줄이면 입자가 뭉개져 사라진다
    progress("크기 맞추는 중", 0);
    const src = working.resize(full, size.width, size.height);
    if (o.flat) params = { film: { enabled: false }, grading: { enabled: false } };
    const pl = pipeline.plan(params, src, src, { lutCache });
    const halo = pl.halation ? pipeline.haloField(src, pl, (f) => progress("빛 번짐 계산", f)) : null;
    const { W, H } = pl;

    if (o.format === "tiff16") {
      const parts = [tiff.header({ width: W, height: H, bits: 16, icc: icc.prophoto() })];
      const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
      pipeline.renderStrips(src, pl, halo, (buf) => {
        const codes = working.toCodes16(buf, new Uint16Array(buf.length));
        const b = new Uint8Array(codes.buffer);
        if (!little) for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
        parts.push(b);
      }, { onProgress: (f) => progress("굽는 중", f) });
      return { blob: env.blob(parts, "image/tiff"), ext: "tif", width: W, height: H };
    }

    const enc = env.canvasEncoder(W, H);
    pipeline.renderStrips(src, pl, halo, (buf, y, rows) => {
      const rgba = new Uint8ClampedArray(W * rows * 4);
      working.toSRGB8(buf, W, rows, 0, y, W, rgba, pl.active);
      enc.put(rgba, y, rows);
    }, { onProgress: (f) => progress("굽는 중", f) });
    progress("파일 쓰는 중", 1);
    const png = o.format === "png";
    const blob = await enc.finish(png ? "image/png" : "image/jpeg", png ? undefined : (o.quality || 92) / 100);
    return { blob, ext: png ? "png" : "jpg", width: W, height: H };
  }

  /** 룩만 파일로 — `.cube`(영상·타 편집기)와 `.xmp`(Lightroom·Camera Raw 프로파일). */
  function exportLook(params, kind, opts) {
    if (kind === "cube") {
      return { text: cube.build(params, opts), name: cube.suggestName(params, opts) };
    }
    return { text: xmp.buildXmp(params, opts), name: xmp.fileNameFor(params, opts) };
  }

  function close() {
    full = proxy = draft = info = null;
    cache.lut.clear(); cache.halo.clear();
  }

  return { open, preview, exportImage, exportLook, close, info: () => info };
}

module.exports = { createSession, PROXY_EDGE, DRAFT_RATIO };
