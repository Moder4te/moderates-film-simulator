#!/usr/bin/env node
/**
 * 안드로이드 앱(android/)의 WebView 자산을 만든다.
 *
 * 앱은 **엔진(색)만** 싣는다 — `core/color`와 엔진 파라미터 스키마(`params.js`).
 * 마감(`core/optics`)·호스트(`host/`)는 넣지 않는다. Photoshop이 없으므로
 * batchPlay·레이어 개념이 아예 없고, 픽셀은 앱이 직접 캔버스에서 읽고 쓴다.
 *
 * 왜 번들인가. WebView에는 `require`가 없다. `core/`는 CommonJS로 쓰여 있고
 * 그것이 노드 검증의 전제라 바꾸지 않는다. 대신 모듈마다 함수로 감싸고
 * require 경로를 **빌드 시점에** 풀어 둔 작은 레지스트리를 만든다.
 * `sync-libs.js`처럼 `core/`가 유일한 원본이고 산출물은 `.gitignore`에 있다.
 *
 *   node tools/build-android-web.js
 *
 * Gradle(`android/app/build.gradle`의 preBuild)도 이 스크립트를 부른다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "android", "web");
const OUT = path.join(ROOT, "android", "app", "src", "main", "assets", "www");

/** 반입 목록. **여기가 앱의 경계 선언이다** — 색만 들어간다. */
const ENTRIES = ["core/color", "apps/engine/src/params.js"];

function listJs(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`없는 경로: ${rel}`);
  if (fs.statSync(abs).isFile()) return [rel];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => path.posix.join(rel, f));
}

const files = ENTRIES.flatMap(listJs);
const known = new Set(files);

const chunks = [];
for (const id of files) {
  const src = fs.readFileSync(path.join(ROOT, id), "utf8").replace(/^﻿/, "");
  const deps = {};
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) throw new Error(`${id} — 외부 모듈 require("${spec}")는 번들에 못 싣는다`);
    let target = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec));
    if (!target.endsWith(".js")) target += ".js";
    if (!known.has(target)) throw new Error(`${id} — require("${spec}") → ${target} 이 반입 목록에 없다`);
    deps[spec] = target;
  }
  chunks.push(
    `defs[${JSON.stringify(id)}] = { deps: ${JSON.stringify(deps)}, fn: function (module, exports, require) {\n${src}\n} };`
  );
}

const bundle = `/* 자동 생성 — tools/build-android-web.js. 직접 고치지 말 것. 원본은 core/color. */
(function (g) {
  "use strict";
  var defs = {};
  var cache = {};
  ${chunks.join("\n")}
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var d = defs[id];
    if (!d) throw new Error("모듈 없음: " + id);
    var module = { exports: {} };
    cache[id] = module;
    d.fn.call(module.exports, module, module.exports, function (spec) {
      return load(d.deps[spec]);
    });
    return module.exports;
  }
  g.FilmSimEngine = { require: load, modules: Object.keys(defs) };
})(typeof self !== "undefined" ? self : this);
`;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(WEB, OUT);
fs.writeFileSync(path.join(OUT, "engine.bundle.js"), bundle);
console.log(`android/app/src/main/assets/www  ←  android/web + ${files.length}개 모듈 번들`);
