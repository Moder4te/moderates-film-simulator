#!/usr/bin/env node
/**
 * .ccx 패키징.
 *
 * `uxp plugin package`는 **manifest가 있는 폴더를 통째로 담고 제외 옵션이 없다.**
 * 저장소 루트에서 그냥 돌리면 `.git`이 전부 들어간다 — 실제로 v1.2.0 배포판에
 * 그렇게 실려 나갔고, 13.2MB 중 12.6MB(98%)가 `.git`이었다.
 *
 * 그래서 런타임에 필요한 것만 `build/`에 모아 거기서 패키징한다.
 *
 * 사용법:
 *   uxp service start        (별도 터미널. 이게 떠 있어야 packaging이 된다)
 *   node tools/build-ccx.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** 경로에 공백이 있어도 깨지지 않게 인용한다. */
const q = (v) => `"${v}"`;

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const DIST = path.join(ROOT, "dist");

/** 두 플러그인을 각각 패키징한다. */
const APPS = ["engine", "finish"];

/** 앱이 실행에 실제로 쓰는 것만. 문서·도구·아카이브는 넣지 않는다. */
const INCLUDE = ["manifest.json", "index.html", "icons", "src", "lib"];

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function sizeOf(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return total;
}

// 공유 층을 각 앱의 lib/로 복사한다. 이걸 빼먹으면 패키지에 core가 없어
// 로드 시점에 죽는다 — 개발 중에는 이전 sync 결과가 남아 있어 드러나지 않는다.
execSync(`node ${q(path.join(__dirname, "sync-libs.js"))}`, { stdio: "inherit" });

fs.mkdirSync(DIST, { recursive: true });

for (const app of APPS) {
  const appRoot = path.join(ROOT, "apps", app);
  const stage = path.join(BUILD, app);

  // manifest는 반드시 BOM 없이. BOM이 붙으면 UDT가 플러그인을 아예 못 읽는다
  // (`Unexpected token ﻿ in JSON at position 0`). docs/UXP-NOTES.md 1.1 참고.
  const manifestRaw = fs.readFileSync(path.join(appRoot, "manifest.json"));
  if (manifestRaw[0] === 0xef && manifestRaw[1] === 0xbb && manifestRaw[2] === 0xbf) {
    throw new Error(`apps/${app}/manifest.json에 UTF-8 BOM이 있습니다.`);
  }
  const manifest = JSON.parse(manifestRaw.toString("utf8"));

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of INCLUDE) {
    const src = path.join(appRoot, name);
    if (!fs.existsSync(src)) throw new Error(`apps/${app}: 빠진 항목 ${name}`);
    copy(src, path.join(stage, name));
  }

  console.log(`
${manifest.id} v${manifest.version} — 스테이징 ${(sizeOf(stage) / 1024).toFixed(0)} KB`);
  execSync(
    `uxp plugin package --manifest ${q(path.join(stage, "manifest.json"))} --outputPath ${q(DIST)}`,
    { stdio: "inherit" }
  );
}

for (const f of fs.readdirSync(DIST)) {
  if (f.endsWith(".ccx")) {
    console.log(`${f}  ${(fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0)} KB`);
  }
}
