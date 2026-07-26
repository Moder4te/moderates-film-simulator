#!/usr/bin/env node
/**
 * 로드 시뮬레이션 — 실기에 올리기 전에 잡을 수 있는 것을 전부 잡는다.
 *
 * UXP·Photoshop·DOM을 스텁으로 갈아끼우고 각 앱의 진입 모듈을 실제로 `require`한다.
 * 로드 시점 예외, 없는 require 경로, `index.html`에 없는 id 참조가 여기서 드러난다.
 *
 * 실기 진단은 오류 메시지가 엉뚱해서(UXP-NOTES 6.1) 한 번에 30분씩 든다.
 * 여기서 3초에 끝나는 것을 거기서 하지 않는다.
 *
 *   node tools/check-load.js
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const APPS = ["engine", "finish"];

// 앱마다 **별도 프로세스**로 돌린다. init()이 비동기라, 한 프로세스에서 둘을
// 이어 돌리면 앞 앱의 지연 실행이 뒤 앱의 DOM 스텁을 건드려 없는 id를 참조한
// 것처럼 보인다(실제로 그렇게 오탐이 났다). 전역을 갈아끼우는 시뮬레이션은
// 격리가 곧 정확성이다.
if (!process.argv[2]) {
  const { spawnSync } = require("child_process");
  let bad = 0;
  for (const app of APPS) {
    const r = spawnSync(process.execPath, [__filename, app], { stdio: "inherit" });
    if (r.status !== 0) bad++;
  }
  console.log("");
  console.log(bad ? `로드 검사 실패 ${bad}개 앱` : "로드 검사 통과 — 두 앱 모두 정상");
  process.exit(bad ? 1 : 0);
}

function makeEl(tag, id) {
  const el = {
    tagName: tag, id: id || "", _children: [], _listeners: {},
    textContent: "", innerHTML: "", value: "", checked: false, disabled: false,
    dataset: {}, style: new Proxy({}, { set: () => true, get: () => "" }),
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    get children() { return this._children; },
    appendChild(c) { this._children.push(c); return c; },
    removeChild(c) { this._children = this._children.filter((x) => x !== c); },
    querySelectorAll() { return this._children; },
    querySelector() { return this._children[0] || null; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 300 }; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    setPointerCapture() {}, releasePointerCapture() {},
    focus() {}, click() {},
  };
  return el;
}

function runApp(app) {
  const appRoot = path.join(ROOT, "apps", app);
  const html = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const touched = new Set();
  const missing = new Set();
  const registry = new Map();

  global.document = {
    getElementById(id) {
      touched.add(id);
      if (!ids.has(id)) missing.add(id);
      if (!registry.has(id)) registry.set(id, makeEl("div", id));
      return registry.get(id);
    },
    createElement: (t) => makeEl(t),
    querySelectorAll: () => [...registry.values()],
    querySelector: () => null,
    addEventListener() {},
    body: makeEl("body"),
  };
  global.window = { devicePixelRatio: 1, addEventListener() {}, setTimeout, clearTimeout };
  global.navigator = { userAgent: "uxp" };

  const uxpStub = {
    entrypoints: { setup: () => {} },
    storage: {
      localFileSystem: {
        getDataFolder: async () => {
          const folder = {
            getEntries: async () => [],
            createFile: async () => ({ write: async () => {} }),
            getEntry: async () => { throw new Error("stub: no entry"); },
            createFolder: async () => folder,
          };
          return folder;
        },
        getFileForSaving: async () => null,
        getFileForOpening: async () => null,
        getFolder: async () => null,
      },
      formats: { utf8: "utf8" },
    },
    shell: {},
  };
  const psStub = {
    app: { activeDocument: null, documents: [] },
    core: { executeAsModal: async (fn) => fn({}, {}) },
    action: { batchPlay: async () => [{}], addNotificationListener: () => {} },
    imaging: {}, constants: {},
  };

  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === "uxp") return uxpStub;
    if (req === "photoshop") return psStub;
    // UXP는 진입 모듈의 상대 경로를 플러그인 루트 기준으로 푼다
    if (req.startsWith("./src/") || req.startsWith("./lib/")) {
      return orig.call(this, path.join(appRoot, req), parent, isMain);
    }
    return orig.apply(this, arguments);
  };

  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  let failed = null;

  try {
    // 모듈 캐시를 비워 앱끼리 상태가 섞이지 않게 한다
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join("apps", app)) || k.includes(path.sep + "core" + path.sep)) {
        delete require.cache[k];
      }
    }
    require(path.join(appRoot, "src/main.js"));
  } catch (e) {
    failed = e;
  } finally {
    console.error = realErr;
  }

  // Module._load는 여기서 되돌리지 않는다. init()이 비동기라 이 함수가 끝난
  // **뒤에** 인라인 require("photoshop")를 부른다. 스텁을 걷으면 그때 죽는다.
  return { failed, errors, touched, missing, restore: () => { Module._load = orig; } };
}

const app = process.argv[2];
const r = runApp(app);

process.on("unhandledRejection", (e) => {
  console.error(`[${app}] 비동기 예외 (init 중)`);
  console.error((e && e.stack) || e);
  process.exitCode = 1;
});

setTimeout(() => {
  r.restore();
  console.log(`[${app}]`);
  if (r.failed) {
    console.log("  로드 실패");
    const NL = String.fromCharCode(10);
    console.log("  " + (r.failed.stack || String(r.failed)).split(NL).slice(0, 4).join(NL + "  "));
    process.exitCode = 1;
  } else {
    console.log(`  로드 성공 — id 참조 ${r.touched.size}개`);
  }
  if (r.missing.size) {
    console.log("  *** index.html에 없는 id ***");
    for (const id of r.missing) console.log("     " + id);
    process.exitCode = 1;
  }
  const real = r.errors.filter((e) => !/프리셋 초기화 실패|리스너 등록 실패/.test(e));
  for (const e of real) console.log("  console.error: " + e);
}, 400);
