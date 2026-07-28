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
const films = require(path.join(ROOT, "core/color/films"));
const scanner = require(path.join(ROOT, "core/color/scanner"));

/**
 * Lua 문자열 리터럴로 감싼다.
 *
 * 필름 이름에 따옴표가 들어갈 일은 없지만, 데이터가 코드가 되는 자리라 막아 둔다 —
 * 나중에 이름이 바뀌었을 때 생성된 Lua가 조용히 깨지는 것이 최악이다.
 */
function luaStr(v) {
  const s = String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  return '"' + s + '"';
}

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
const catalog = [];
for (const p of set) {
  const text = xmp.buildXmp(p, { space: "prophoto" });
  const file = xmp.fileNameFor(p);
  fs.writeFileSync(path.join(profDir, file), text, "utf8");
  bytes += Buffer.byteLength(text, "utf8");

  const name = xmp.profileName(p);
  names.push(name);

  // UUID는 **생성된 파일에서 그대로 뽑는다.** 따로 계산하면 파일과 어긋날 수 있고,
  // 어긋나면 플러그인이 존재하지 않는 프로파일을 가리켜 조용히 실패한다.
  const m = text.match(/crs:UUID="([^"]+)"/);
  if (!m) {
    console.error(`UUID를 못 찾았습니다: ${file}`);
    process.exit(1);
  }

  // RGBTable도 같이 뽑는다. **이게 실제 색 변환을 가리키는 키다.**
  // UUID만 넘기면 Lightroom이 프로파일을 찾아 이름·강도까지는 표시하지만
  // 색은 걸리지 않는다 — 실기에서 확인했다(RESOLVED 참조).
  const t = text.match(/crs:RGBTable="([^"]+)"/);
  if (!t) {
    console.error(`RGBTable을 못 찾았습니다: ${file}`);
    process.exit(1);
  }

  catalog.push({
    film: films.byId(p.film.id).displayName,
    scanner: scanner.byId(p.film.scanner).displayName,
    name,
    uuid: m[1],
    rgbTable: t[1],
    file,
  });
}

// ── 카탈로그를 Lua로 내보낸다 ──────────────────────────────────────────
// 플러그인은 프로파일을 **이름으로 조회할 수 없다**(SDK가 그 기능을 주지 않는다).
// 그래서 무엇이 담겼는지를 여기서 적어 넘긴다.
const rows = catalog.map(
  (c) =>
    "  { film = " + luaStr(c.film) +
    ", scanner = " + luaStr(c.scanner) +
    ", name = " + luaStr(c.name) +
    ", uuid = " + luaStr(c.uuid) +
    ", rgbTable = " + luaStr(c.rgbTable) +
    ", file = " + luaStr(c.file) + " },"
);
const lua = [
  "-- 자동 생성 파일. 직접 고치지 말 것 — tools/build-lrplugin.js가 다시 쓴다.",
  "return {",
  ...rows,
  "}",
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "Profiles.lua"), lua, "utf8");

// ── 3. 확인 ────────────────────────────────────────────────────────────
// 이름이 겹치면 파일이 조용히 덮어써져 개수가 맞지 않는다. 세어서 못 박는다.
const written = fs.readdirSync(profDir).filter((f) => f.endsWith(".xmp"));
if (written.length !== set.length) {
  console.error(
    `프로파일 이름이 겹칩니다 — ${set.length}개를 굽었는데 파일은 ${written.length}개입니다.`
  );
  process.exit(1);
}

// 카탈로그가 없는 파일을 가리키면 플러그인은 **조용히** 아무 일도 하지 않는다.
// Lua는 여기서 실행할 수 없으니, 검사할 수 있는 것만이라도 여기서 막는다.
const onDisk = new Set(written);
const dangling = catalog.filter((c) => !onDisk.has(c.file));
if (dangling.length > 0) {
  console.error(`카탈로그가 없는 파일을 가리킵니다:\n  ${dangling.map((c) => c.file).join("\n  ")}`);
  process.exit(1);
}

// RGBTable ID는 표 내용에서 나온다. 두 조합이 같은 ID를 가지면 색이 실제로 같다는
// 뜻이다 — 필름이나 스캐너 단계가 결과에 반영되지 않은 것이라 조용히 넘길 수 없다.
const byTable = new Map();
for (const c of catalog) {
  const prev = byTable.get(c.rgbTable);
  if (prev) {
    console.error(`색이 같은 조합이 있습니다:\n  ${prev}\n  ${c.name}\n  RGBTable ${c.rgbTable}`);
    process.exit(1);
  }
  byTable.set(c.rgbTable, c.name);
}

// 팝업은 필름 × 스캐너 격자다. 빠진 칸이 있으면 고를 수는 있는데 적용이 안 된다.
const filmSet = [...new Set(catalog.map((c) => c.film))];
const scanSet = [...new Set(catalog.map((c) => c.scanner))];
if (catalog.length !== filmSet.length * scanSet.length) {
  console.error(
    `조합이 격자를 못 채웁니다 — 필름 ${filmSet.length} × 스캐너 ${scanSet.length} = ` +
      `${filmSet.length * scanSet.length}인데 프로파일은 ${catalog.length}개입니다.`
  );
  process.exit(1);
}

// Lua 파일이 전부 담겼는지 — 하나라도 빠지면 메뉴가 로드 시점에 죽는다.
for (const f of ["Info.lua", "Install.lua", "Apply.lua", "Inspect.lua", "Profiles.lua"]) {
  if (!fs.existsSync(path.join(OUT, f))) {
    console.error(`빠진 파일: ${f}`);
    process.exit(1);
  }
}

// ── 메뉴 검사 ──────────────────────────────────────────────────────────
// 라이브러리 메뉴는 **라이브러리 모듈에 있을 때만** 나온다. 파일 메뉴는 어디서나
// 나온다. 그래서 항목이 한쪽에만 있으면 다른 모듈에서 그 기능이 사라진다 —
// 진단 항목을 라이브러리에만 뒀다가 정작 현상 모듈에서 못 찾은 적이 있다.
const info = fs.readFileSync(path.join(OUT, "Info.lua"), "utf8");

function menuFiles(key) {
  const i = info.indexOf(key);
  if (i < 0) return null;
  const end = info.indexOf("\n  },", i);
  if (end < 0) return null;
  return [...info.slice(i, end).matchAll(/file\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

const menus = { LrLibraryMenuItems: menuFiles("LrLibraryMenuItems"), LrExportMenuItems: menuFiles("LrExportMenuItems") };
for (const [key, list] of Object.entries(menus)) {
  if (!list || list.length === 0) {
    console.error(`Info.lua에서 ${key}를 읽지 못했습니다.`);
    process.exit(1);
  }
  for (const f of list) {
    if (!fs.existsSync(path.join(OUT, f))) {
      console.error(`${key}가 없는 파일을 가리킵니다: ${f}`);
      process.exit(1);
    }
  }
}

const onlyLib = menus.LrLibraryMenuItems.filter((f) => !menus.LrExportMenuItems.includes(f));
const onlyExp = menus.LrExportMenuItems.filter((f) => !menus.LrLibraryMenuItems.includes(f));
if (onlyLib.length || onlyExp.length) {
  console.error(
    "두 메뉴의 항목이 다릅니다 — 한쪽에만 있으면 다른 모듈에서 사라집니다.\n" +
      (onlyLib.length ? `  라이브러리에만: ${onlyLib.join(", ")}\n` : "") +
      (onlyExp.length ? `  파일에만: ${onlyExp.join(", ")}\n` : "")
  );
  process.exit(1);
}

const rel = path.relative(ROOT, OUT).replace(/\\/g, "/");
console.log(`${rel}`);
console.log(`  프로파일 ${written.length}개  ${(bytes / 1024 / 1024).toFixed(1)}MB`);
console.log(`  예: ${names.slice(0, 3).join(" · ")} …`);
console.log(`  카탈로그: Profiles.lua (필름 ${new Set(catalog.map((c) => c.film)).size}종 × 스캐너 ${new Set(catalog.map((c) => c.scanner)).size}종)`);
console.log("");
console.log("배포: 이 폴더를 그대로 압축해 올린다.");
console.log("설치: Lightroom Classic → 파일 > 플러그인 관리자 > 추가 → 이 폴더 선택");
console.log("      그다음 라이브러리 > 플러그인 추가 기능 > 필름 프로파일 설치");
