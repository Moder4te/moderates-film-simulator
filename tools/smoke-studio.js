#!/usr/bin/env node
/**
 * 독립 실행형 **브라우저 실기 검사** — 빌드한 HTML을 진짜 Chromium에서 돌린다.
 *
 *   node tools/smoke-studio.js [스크린샷 폴더]
 *
 * `check-studio.js`는 계산을 노드에서 본다. 여기는 그게 못 보는 것 — 워커가 뜨는가,
 * 브라우저가 푼 JPEG이 들어오는가, 캔버스로 내보내지는가, 폰 화면에서 배치가
 * 무너지지 않는가 — 를 본다. **파일로 직접 연 경우(file://)** 와 **서버로 연 경우**
 * 둘 다 돈다. 배포 형태가 그 둘이다.
 *
 * Playwright가 필요해서 `check.js`에는 넣지 않았다(이 저장소는 의존성이 0이고 CI에도
 * 브라우저가 없다). 없으면 건너뛴다고 알리고 0으로 끝난다.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

let chromium, devices;
try {
  ({ chromium, devices } = require("playwright"));
} catch (e) {
  console.log("playwright가 없어 브라우저 검사를 건너뜁니다 (계산 검사는 tools/check-studio.js)");
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");
const tiff = require(path.join(ROOT, "core/io/tiff"));
const icc = require(path.join(ROOT, "core/io/icc"));
const { build } = require("./build-studio.js");

const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "  OK " : "FAIL "} ${name}${extra ? "  " + extra : ""}`);
};

/** 시험 사진 — 하늘·피부색 면·밝은 창(할레이션)·어두운 구석. */
function scene(w, h) {
  const d = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h, o = (y * w + x) * 3;
    let r = 0.25 + 0.3 * u, g = 0.3 + 0.25 * v, b = 0.45 - 0.2 * v; // 바탕
    if (v > 0.55) { r = 0.42 - 0.2 * u; g = 0.33 - 0.15 * u; b = 0.26 - 0.12 * u; } // 따뜻한 면
    const dx = u - 0.72, dy = v - 0.3;
    if (dx * dx * (w / h) ** 2 + dy * dy < 0.012) { r = g = b = 0.98; } // 창
    if (u < 0.18 && v > 0.7) { r = g = b = 0.04; }
    d[o] = r * 65535; d[o + 1] = g * 65535; d[o + 2] = b * 65535;
  }
  return d;
}

function pngOf(w, h, rgb16) {
  // 8bit RGB PNG — 브라우저 디코드 경로용
  const crc = (buf) => zlib.crc32 ? zlib.crc32(buf) : (() => {
    let c, t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff;
    for (const b of buf) x = t[(x ^ b) & 255] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  })();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body) >>> 0);
    return Buffer.concat([len, body, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb16[y * w * 3 + x] >> 8;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function run(label, url, contextOpts, tmp) {
  console.log(`\n${label}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, contextOpts));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(url);

  const statusText = () => page.locator("#status").textContent();
  const waitRender = async (re) => {
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById("status").textContent), re.source, { timeout: 60000 });
    return statusText();
  };
  const pixel = (x, y) => page.evaluate(([px, py]) => {
    const c = document.getElementById("canvas");
    const d = c.getContext("2d").getImageData(Math.floor(c.width * px), Math.floor(c.height * py), 1, 1).data;
    return [d[0], d[1], d[2], c.width, c.height];
  }, [x, y]);
  const setRange = (path, value) => page.evaluate(([label, v]) => {
    const row = [...document.querySelectorAll(".row.range")].find((r) => r.querySelector(".name").textContent === label);
    const input = row.querySelector("input");
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [path, value]);

  ok("페이지가 뜨고 워커가 돈다", /백그라운드 처리/.test(await page.locator("#about").textContent()), await page.locator("#about").textContent());

  // ── 16bit TIFF ──
  await page.setInputFiles("#fileOpen", path.join(tmp, "scene16.tif"));
  let s = await waitRender(/^맞춤 \d+×\d+/);
  const info = await page.locator("#fileInfo").textContent();
  const a = await pixel(0.4, 0.3);
  ok("16bit ProPhoto TIFF를 열어 그린다", a[3] > 0 && /16비트/.test(info) && /ProPhoto/.test(info), `${s} — ${info}`);
  ok("  └ 16bit 정상 입력에는 경고가 없다", await page.locator("#warnings").isHidden());
  if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/\W+/g, "_")}_1_fit.png`) });

  // 원본 대비 — 필름이 실제로 색을 바꿨는가
  await page.locator("#btnCompare").dispatchEvent("pointerdown");
  await waitRender(/^원본/);
  const orig = await pixel(0.4, 0.3);
  await page.locator("#btnCompare").dispatchEvent("pointerup");
  await waitRender(/^맞춤/);
  ok("「원본」을 누르는 동안 원본이 보인다", Math.abs(orig[0] - a[0]) + Math.abs(orig[1] - a[1]) + Math.abs(orig[2] - a[2]) > 6,
    `원본 ${orig.slice(0, 3)} ↔ 결과 ${a.slice(0, 3)}`);

  // 슬라이더 → 다시 굽는다
  await page.locator("#sec-tone > summary").click();
  await setRange("노출", 1);
  await page.waitForTimeout(400);
  await waitRender(/^맞춤/);
  const brighter = await pixel(0.4, 0.3);
  ok("슬라이더를 움직이면 다시 굽는다", brighter[1] > a[1] + 10, `G ${a[1]} → ${brighter[1]}`);
  await setRange("노출", 0);
  await page.waitForTimeout(400);
  await waitRender(/^맞춤/);

  // 1:1
  await page.locator("#btnCrop").click();
  s = await waitRender(/^1:1/);
  const crop = await pixel(0.5, 0.5);
  ok("1:1 보기 — 화면만큼만 원본 해상도로", crop[3] > 0 && crop[3] <= 2400, s);
  if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/\W+/g, "_")}_2_crop.png`) });
  await page.locator("#btnFit").click();
  await waitRender(/^맞춤/);

  // 내보내기 — JPEG(캔버스 인코더)와 TIFF(직접 쓰기)
  await page.locator("#sec-export > summary").click();
  const save = async (format) => {
    await page.selectOption("#expFormat", format);
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.locator("#btnExport").click()]);
    const file = path.join(tmp, `${label.replace(/\W+/g, "_")}_${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
  };
  const jpg = await save("jpeg");
  ok("JPEG 저장", jpg.name === "scene16_filmsim.jpg" && jpg.bytes[0] === 0xff && jpg.bytes[1] === 0xd8 && jpg.bytes.length > 5000,
    `${jpg.name} ${(jpg.bytes.length / 1024).toFixed(0)}KB`);
  const tif = await save("tiff16");
  const dec = await tiff.decode(tif.bytes);
  ok("TIFF 16bit 저장 — 원본 크기, ProPhoto ICC", dec.width === 900 && dec.height === 600 && dec.bits === 16 && icc.classify(icc.describe(dec.icc)) === "prophoto",
    `${tif.name} ${dec.width}×${dec.height}`);

  // ── 8bit PNG(브라우저 디코드) ──
  await page.setInputFiles("#fileOpen", path.join(tmp, "scene8.png"));
  await waitRender(/^맞춤 \d+×\d+/);
  ok("8bit PNG를 브라우저 디코더로 연다", /8비트/.test(await page.locator("#fileInfo").textContent()) || (await pixel(0.5, 0.5))[3] > 0);
  ok("  └ 8bit에 필름을 걸면 경고가 뜬다", /8비트/.test(await page.locator("#warnings").textContent()));

  // 룩 내보내기
  const [cubeDl] = await Promise.all([page.waitForEvent("download"), page.locator("#btnCube").click()]);
  ok(".cube 저장", cubeDl.suggestedFilename().endsWith(".cube"), cubeDl.suggestedFilename());

  // 프리셋
  await page.selectOption("#presetList", { index: 2 });
  await page.waitForTimeout(300);
  await waitRender(/^(맞춤|프리셋)/);
  ok("프리셋을 고르면 값이 바뀐다", /Night Halation/.test(await page.locator("#presetList option:checked").textContent()));

  if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/\W+/g, "_")}_3_panel.png`), fullPage: false });
  ok("콘솔 오류 없음", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
}

(async () => {
  build();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filmsim-smoke-"));
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const w = 900, h = 600, img = scene(w, h);
  fs.writeFileSync(path.join(tmp, "scene16.tif"), tiff.encode({ width: w, height: h, bits: 16, icc: icc.prophoto() }, img));
  fs.writeFileSync(path.join(tmp, "scene8.png"), pngOf(w, h, img));

  const dist = path.join(ROOT, "dist/studio");
  const server = http.createServer((req, res) => {
    const f = path.join(dist, req.url === "/" ? "index.html" : req.url.slice(1));
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  await run("파일로 직접 열기 (file://) — 데스크톱", "file://" + path.join(dist, "index.html"), { viewport: { width: 1280, height: 800 } }, tmp);
  await run("서버로 열기 (http) — 폰 화면", `http://127.0.0.1:${port}/`, devices["Pixel 7"], tmp);

  server.close();
  console.log(fails ? `\n브라우저 검사 실패 ${fails}건` : "\n브라우저 검사 통과");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
