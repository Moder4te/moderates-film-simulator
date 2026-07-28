/**
 * Lightroom Classic 배포 패키지를 만든다 — `dist/FilmSim.lrplugin/`.
 *
 * 프로파일 생성은 **순수 계산**이라(`core/io/xmp`) Photoshop이 필요 없다. 그래서
 * 엔진 패널에서 "세트 전체"를 눌러 폴더를 고르는 왕복 없이, 여기서 전부 굽는다.
 *
 * 플러그인 자체는 색을 계산하지 않는다 — 이유는 `lrplugin/Info.lua` 주석 참조.
 *
 *   node tools/build-lrplugin.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "lrplugin");
const OUT = path.join(ROOT, "dist", "FilmSim.lrplugin");

const { defaultParams } = require(path.join(ROOT, "apps/engine/src/params"));
const xmp = require(path.join(ROOT, "core/io/xmp"));

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── 1. 플러그인 뼈대 복사 ──────────────────────────────────────────────
rmrf(OUT);
copyDir(SRC, OUT);

// ── 2. 프로파일 굽기 ───────────────────────────────────────────────────
const params = defaultParams();
const set = xmp.defaultSet(params);
const profDir = path.join(OUT, "profiles");
fs.mkdirSync(profDir, { recursive: true });

let bytes = 0;
const names = [];
for (const p of set) {
  const text = xmp.buildXmp(p, { space: "prophoto" });
  const file = xmp.fileNameFor(p);
  fs.writeFileSync(path.join(profDir, file), text, "utf8");
  bytes += Buffer.byteLength(text, "utf8");
  names.push(xmp.profileName(p));
}

// ── 3. 확인 ────────────────────────────────────────────────────────────
// 이름이 겹치면 파일이 조용히 덮어써져 개수가 맞지 않는다. 세어서 못 박는다.
const written = fs.readdirSync(profDir).filter((f) => f.endsWith(".xmp"));
if (written.length !== set.length) {
  console.error(
    `프로파일 이름이 겹칩니다 — ${set.length}개를 굽었는데 파일은 ${written.length}개입니다.`
  );
  process.exit(1);
}

const rel = path.relative(ROOT, OUT).replace(/\\/g, "/");
console.log(`${rel}`);
console.log(`  프로파일 ${written.length}개  ${(bytes / 1024 / 1024).toFixed(1)}MB`);
console.log(`  예: ${names.slice(0, 3).join(" · ")} …`);
console.log("");
console.log("배포: 이 폴더를 그대로 압축해 올린다.");
console.log("설치: Lightroom Classic → 파일 > 플러그인 관리자 > 추가 → 이 폴더 선택");
console.log("      그다음 라이브러리 > 플러그인 추가 기능 > 필름 프로파일 설치");
