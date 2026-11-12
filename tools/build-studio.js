#!/usr/bin/env node
/**
 * 독립 실행형(apps/studio)을 **HTML 파일 하나**로 묶는다.
 *
 *   node tools/build-studio.js        →  dist/studio/index.html (+ PWA 부속)
 *
 * ── 왜 파일 하나인가 ────────────────────────────────────────────────────
 *
 * 그 파일 하나가 곧 프로그램이다. Windows에서는 더블클릭하면 브라우저에서 열리고,
 * 폰으로는 파일을 옮겨 열면 된다. 설치도 서버도 필요 없다. 웹에 올리면(https)
 * 같은 파일이 설치형 앱(PWA)이 된다 — 그때만 옆의 sw.js·manifest가 쓰인다.
 *
 * ── 왜 번들러를 직접 짰나 ───────────────────────────────────────────────
 *
 * 이 저장소는 의존성이 0이다(package.json도 없다). 필요한 것은 "CommonJS 모듈
 * 수십 개를 한 스크립트로 잇는 것"뿐이고 그건 수십 줄이다. `core/`가 순수 계산이라
 * (photoshop·uxp·node 모듈을 부르지 않는다 — check-boundaries 규칙 1) 변환 없이
 * 브라우저에서 그대로 돈다.
 *
 * UXP 플러그인은 `apps/<app>/lib/`로 **복사**해서 쓴다(.ccx가 폴더째 담기므로 —
 * sync-libs.js). 여기는 묶어 버리므로 복사가 필요 없고, `core/`를 직접 가리킨다.
 *
 * 워커 소스는 문자열로 박는다. 파일 하나로 배포하려면 worker.js를 따로 둘 수 없어서
 * 페이지가 Blob URL로 띄운다(`apps/studio/src/client.js`).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "apps/studio");
const OUT = path.join(ROOT, "dist/studio");

/** 진입 파일에서 시작해 require 그래프를 한 스크립트로 묶는다. */
function bundle(entry) {
  const ids = new Map(); // 절대 경로 → 번호
  const bodies = [];

  function add(file) {
    if (ids.has(file)) return ids.get(file);
    const id = ids.size;
    ids.set(file, id);
    bodies.push(null);
    const src = fs.readFileSync(file, "utf8");
    const code = src.replace(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g, (whole, q, spec) => {
      if (!spec.startsWith(".")) {
        throw new Error(`${path.relative(ROOT, file)}: require("${spec}") — 브라우저에는 그 모듈이 없다`);
      }
      const base = path.resolve(path.dirname(file), spec);
      const target = [base, base + ".js"].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      // 주석 속의 예시 경로일 수 있다. 실제 코드면 실행 시 `require is not defined`로
      // 드러나고, tools/check-studio.js가 번들을 한 번 돌려 그걸 잡는다
      if (!target) return whole;
      return `__req(${add(target)})`;
    });
    bodies[id] = `/* ${path.relative(ROOT, file).replace(/\\/g, "/")} */\nfunction(module, exports){\n${code}\n}`;
    return id;
  }

  const main = add(entry);
  return (
    "(function(){\n\"use strict\";\nvar __cache={};\n" +
    "function __req(i){var m=__cache[i];if(m)return m.exports;m=__cache[i]={exports:{}};__mods[i](m,m.exports);return m.exports;}\n" +
    `var __mods=[\n${bodies.join(",\n")}\n];\n__req(${main});\n})();\n`
  );
}

/** `<script>` 안에 그대로 넣을 수 있게 — 닫는 태그와 주석 여는 표시를 끊는다. */
const inline = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

function build() {
  const version = require(path.join(APP, "src/version.js"));
  const worker = bundle(path.join(APP, "src/worker.js"));
  const main = bundle(path.join(APP, "src/main.js"));
  // RAW 현상부(LibRaw WebAssembly) — 저장소에 커밋된 바이너리를 base64로 싣는다.
  // 다시 빌드하려면 tools/build-raw-wasm.sh. 한 번만 싣고 워커에는 메인이 건넨다
  const wasmFile = path.join(APP, "vendor/filmsim-raw.wasm");
  const wasm = fs.existsSync(wasmFile) ? fs.readFileSync(wasmFile).toString("base64") : null;
  const script =
    `var __FILMSIM_WORKER__=${JSON.stringify(worker)};\n` +
    `var __FILMSIM_RAW_WASM__=${JSON.stringify(wasm)};\n${main}`;

  const template = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  const mark = "/*__BUNDLE__*/";
  if (!template.includes(mark)) throw new Error("apps/studio/index.html에 번들 자리 표시가 없다");
  // 함수로 넣는다 — 문자열로 넣으면 소스 안의 `$&` 같은 것이 치환 패턴으로 읽힌다
  const html = template.replace(mark, () => inline(script));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  fs.writeFileSync(path.join(OUT, "sw.js"), fs.readFileSync(path.join(APP, "sw.js"), "utf8").replace("__VERSION__", version));
  fs.copyFileSync(path.join(APP, "manifest.webmanifest"), path.join(OUT, "manifest.webmanifest"));
  for (const f of fs.readdirSync(path.join(APP, "icons"))) fs.copyFileSync(path.join(APP, "icons", f), path.join(OUT, f));
  return { html, worker, main, version, file: path.join(OUT, "index.html") };
}

module.exports = { build, bundle };

if (require.main === module) {
  const r = build();
  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
  console.log(`dist/studio/index.html  ${kb(r.html)}KB  (화면 ${kb(r.main)}KB + 워커 ${kb(r.worker)}KB) · v${r.version}`);
  console.log("  열기: 이 파일을 브라우저로 열거나,  node tools/serve-studio.js  로 같은 네트워크의 폰에서 접속");
}
