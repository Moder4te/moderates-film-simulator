#!/usr/bin/env node
/**
 * dist/studio를 같은 네트워크에 내놓는다 — **폰에서 열어 보는 용도.**
 *
 *   node tools/build-studio.js && node tools/serve-studio.js [포트]
 *
 * PC와 폰이 같은 Wi-Fi에 있으면 폰 브라우저에서 아래 찍히는 주소로 들어간다.
 * 사진은 폰 안에서 처리되고 이 서버로 올라오지 않는다 — 서버는 파일을 내려 줄 뿐이다.
 *
 * ⚠️ http라서 **설치(홈 화면에 앱으로 추가)와 오프라인은 안 된다.** 그건 https가
 * 필요하다(브라우저 규칙). 쓰는 데는 지장이 없다.
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.resolve(__dirname, "../dist/studio");
const PORT = Number(process.argv[2]) || 8080;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
};

if (!fs.existsSync(path.join(DIR, "index.html"))) {
  console.error("dist/studio/index.html이 없습니다 — 먼저  node tools/build-studio.js");
  process.exit(1);
}

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(DIR, rel);
    // 폴더 밖으로 나가는 경로는 주지 않는다
    if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("없음");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`FilmSim Studio — http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  같은 네트워크의 폰에서: http://${a.address}:${PORT}`);
    }
  });
