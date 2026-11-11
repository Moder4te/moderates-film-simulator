/**
 * FilmSim Studio — 화면.
 *
 * 계산은 전부 세션(`session.js` → `core/render`)이 하고 여기는 세 가지만 한다:
 * 컨트롤 표에서 패널을 만들고, 값이 바뀌면 다시 구워 달라고 하고, 받은 픽셀을 그린다.
 *
 * ── 미리보기 요청은 "마지막 것만" ───────────────────────────────────────
 *
 * 슬라이더를 끌면 이벤트가 렌더보다 훨씬 빨리 쏟아진다. 전부 줄 세우면 손을 뗀 뒤에도
 * 옛 값이 한참 그려진다. 그래서 굽는 중에 온 요청은 **가장 최근 하나만** 기억했다가
 * 끝나면 그것을 굽는다. 끄는 동안은 초안(작은 대리본), 손을 떼면 본 대리본.
 */

const P = require("./params");
const { SECTIONS } = require("./controls");
const { createClient } = require("./client");
const cube = require("../../../core/io/cube");
const xmp = require("../../../core/io/xmp");
const films = require("../../../core/color/films");
const VERSION = require("./version");

const $ = (id) => document.getElementById(id);
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

const STORE_PRESETS = "filmsim.studio.presets";
const STORE_CURRENT = "filmsim.studio.current";
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 저장 못 해도 동작은 한다 */ } },
};

const DEFAULTS = P.defaultParams();
let params = P.migrate(store.get(STORE_CURRENT) || {});
let info = null;
let view = { mode: "fit" };
let comparing = false;
const refreshers = []; // 파라미터 → 화면 (프리셋을 불러왔을 때)

// ── 상태 줄 ──────────────────────────────────────────────────────────────

function status(text, kind) {
  $("status").textContent = text || "";
  $("status").className = kind || "";
}
function progress(label, fraction) {
  const bar = $("progress");
  if (fraction == null || fraction >= 1) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.value = fraction;
  status(`${label} ${Math.round(fraction * 100)}%`);
}

const client = createClient(progress);

// ── 미리보기 ─────────────────────────────────────────────────────────────

let inflight = false;
let wanted = null;
let settle = 0;

function viewSpec(draft) {
  if (view.mode === "crop") {
    const box = cropBox();
    return { mode: "crop", x: view.cx - box.w / 2, y: view.cy - box.h / 2, w: box.w, h: box.h, original: comparing };
  }
  return { mode: "fit", draft, original: comparing };
}

/** 1:1 보기에서 구울 사각형 크기 — 화면에 보이는 만큼만(기기 픽셀 기준). */
function cropBox() {
  const stage = $("stage");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(stage.clientWidth * dpr), h = Math.round(stage.clientHeight * dpr);
  // 폰의 고해상도 화면에서 사각형이 너무 커지지 않게 — 2MP면 충분하다
  const k = Math.min(1, Math.sqrt(2_000_000 / Math.max(1, w * h)));
  w = Math.round(w * k); h = Math.round(h * k);
  return { w: Math.max(64, Math.min(w, info.width)), h: Math.max(64, Math.min(h, info.height)), dpr };
}

async function pump() {
  if (inflight) return;
  inflight = true;
  try {
    while (wanted) {
      const job = wanted;
      wanted = null;
      try {
        draw(await client.preview(params, viewSpec(job.draft)));
      } catch (e) {
        status(e.message, "error");
      }
    }
  } finally {
    inflight = false;
  }
}

/** @param {boolean} draft 끄는 중이면 true — 초안으로 굽고, 멈추면 본 대리본으로 다시 */
function render(draft) {
  if (!info) return;
  clearTimeout(settle);
  wanted = { draft: !!draft && view.mode === "fit" };
  pump();
  if (draft) settle = setTimeout(() => render(false), 220);
}

function draw(res) {
  const canvas = $("canvas");
  if (canvas.width !== res.width || canvas.height !== res.height) {
    canvas.width = res.width; canvas.height = res.height;
  }
  canvas.getContext("2d").putImageData(new ImageData(res.rgba, res.width, res.height), 0, 0);
  canvas.style.transform = "";
  if (res.view.mode === "crop") {
    const dpr = cropBox().dpr;
    canvas.style.width = `${res.width / dpr}px`;
    canvas.style.height = `${res.height / dpr}px`;
    view.cx = res.view.x + res.width / 2;
    view.cy = res.view.y + res.height / 2;
  } else {
    canvas.style.width = canvas.style.height = "";
  }
  canvas.dataset.mode = res.view.mode;
  showWarnings(res.warnings);
  const what = comparing ? "원본" : res.view.mode === "crop" ? "1:1" : res.view.draft ? "초안" : "맞춤";
  status(`${what} ${res.width}×${res.height} · ${res.ms}ms`);
}

/**
 * 경고는 그림 위에 뜬다. 한 번 눌러 닫으면 **같은 내용**은 다시 띄우지 않는다 —
 * 슬라이더를 움직일 때마다 되살아나면 폰에서는 그림의 절반을 계속 가린다.
 * 내용이 달라지면(다른 문제가 생기면) 다시 뜬다.
 */
let dismissed = "";
function showWarnings(list) {
  const box = $("warnings");
  const text = (list || []).join("\n");
  box.replaceChildren(
    ...(list || []).map((m) => el("p", { text: m.replace(/\*\*/g, "") })),
    el("small", { text: "눌러서 닫기" })
  );
  box.hidden = !text || text === dismissed;
  box.onclick = () => { dismissed = text; box.hidden = true; };
}

function setMode(mode, at) {
  if (!info) return;
  if (mode === "crop") {
    view = { mode: "crop", cx: at ? at.x : (view.cx != null ? view.cx : info.width / 2), cy: at ? at.y : (view.cy != null ? view.cy : info.height / 2) };
  } else {
    view = { mode: "fit", cx: view.cx, cy: view.cy };
  }
  $("btnFit").classList.toggle("on", mode === "fit");
  $("btnCrop").classList.toggle("on", mode === "crop");
  render(false);
}

function bindViewer() {
  const canvas = $("canvas");
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!info || view.mode !== "crop") return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
    // 끄는 동안은 그림만 민다 — 원본 해상도 사각형을 매 프레임 다시 구울 수는 없다
    canvas.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
  });
  const end = () => {
    if (!drag) return;
    const dpr = cropBox().dpr;
    view.cx -= drag.dx * dpr; view.cy -= drag.dy * dpr;
    const moved = Math.abs(drag.dx) + Math.abs(drag.dy) > 2;
    drag = null;
    if (moved) render(false); else canvas.style.transform = "";
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // 맞춤 보기에서 두 번 누르면 그 자리를 1:1로
  canvas.addEventListener("dblclick", (e) => {
    if (!info) return;
    if (view.mode === "crop") { setMode("fit"); return; }
    const r = canvas.getBoundingClientRect();
    setMode("crop", { x: ((e.clientX - r.left) / r.width) * info.width, y: ((e.clientY - r.top) / r.height) * info.height });
  });

  $("btnFit").addEventListener("click", () => setMode("fit"));
  $("btnCrop").addEventListener("click", () => setMode("crop"));

  const hold = $("btnCompare");
  const on = (e) => { e.preventDefault(); if (!comparing) { comparing = true; hold.classList.add("on"); render(false); } };
  const off = () => { if (comparing) { comparing = false; hold.classList.remove("on"); render(false); } };
  hold.addEventListener("pointerdown", on);
  hold.addEventListener("pointerup", off);
  hold.addEventListener("pointerleave", off);
  hold.addEventListener("pointercancel", off);
  hold.addEventListener("contextmenu", (e) => e.preventDefault());

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (info && view.mode === "crop") render(false); }, 200);
  });
}

// ── 파일 ─────────────────────────────────────────────────────────────────

function proxyEdge() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return Math.round(Math.max(screen.width, screen.height) * dpr);
}

async function openFile(file) {
  status(`${file.name} 여는 중…`);
  try {
    info = await client.open(await file.arrayBuffer(), file.name, file.type, { proxyEdge: proxyEdge() });
  } catch (e) {
    progress(null);
    status(e.message, "error");
    return false;
  }
  progress(null);
  dismissed = "";
  document.body.classList.add("loaded");
  const mp = ((info.width * info.height) / 1e6).toFixed(1);
  $("fileInfo").textContent =
    `${info.name} · ${info.width}×${info.height} (${mp}MP) · ${info.bits}비트 · ${info.profile || "프로파일 없음"}`;
  view = { mode: "fit" };
  $("btnFit").classList.add("on"); $("btnCrop").classList.remove("on");
  render(false);
  return true;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const baseName = (name) => String(name || "image").replace(/\.[^.]+$/, "");

function exportOptions() {
  const edge = $("expEdge").value;
  return {
    format: $("expFormat").value,
    quality: Number($("expQuality").value),
    longEdge: edge === "custom" ? Number($("expEdgeCustom").value) || 0 : Number(edge) || 0,
  };
}

async function exportCurrent() {
  if (!info) return;
  lock(true);
  try {
    const t0 = Date.now();
    const r = await client.exportImage(params, exportOptions());
    // 원본 이름에 꼬리를 붙인다 — 같은 폴더에 받아도 원본을 덮지 않는다
    const name = `${baseName(info.name)}_filmsim.${r.ext}`;
    download(r.blob, name);
    status(`저장: ${name} · ${r.width}×${r.height} · ${((Date.now() - t0) / 1000).toFixed(1)}초`, "done");
  } catch (e) {
    status(e.message, "error");
  } finally {
    progress(null);
    lock(false);
  }
}

/**
 * 여러 장을 같은 설정으로. 폴더를 고를 수 있으면(데스크톱 Chrome·Edge) 거기에 쓰고,
 * 아니면 한 장씩 내려받는다. 어느 쪽이든 이름에 `_filmsim`이 붙어 원본과 겹치지 않는다.
 */
async function exportBatch(files) {
  if (!files.length) return;
  let dir = null;
  if (window.showDirectoryPicker) {
    try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch (e) { if (e.name === "AbortError") return; }
  }
  lock(true);
  const opts = exportOptions();
  let done = 0;
  const failed = [];
  try {
    for (const file of files) {
      status(`일괄 ${done + 1}/${files.length} — ${file.name}`);
      try {
        info = await client.open(await file.arrayBuffer(), file.name, file.type, { proxyEdge: proxyEdge() });
        const r = await client.exportImage(params, opts);
        const name = `${baseName(file.name)}_filmsim.${r.ext}`;
        if (dir) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(r.blob);
          await w.close();
        } else {
          download(r.blob, name);
        }
        done++;
      } catch (e) {
        failed.push(`${file.name}: ${e.message}`);
      }
    }
  } finally {
    progress(null);
    lock(false);
  }
  if (info) {
    document.body.classList.add("loaded");
    $("fileInfo").textContent = `${info.name} · ${info.width}×${info.height} · ${info.bits}비트`;
    view = { mode: "fit" };
    render(false);
  }
  status(
    failed.length ? `일괄 ${done}/${files.length}장 완료. 실패 — ${failed.join(" / ")}` : `일괄 ${done}장 완료`,
    failed.length ? "error" : "done"
  );
}

async function exportLook(kind) {
  try {
    const opts = kind === "cube"
      ? { size: Number($("lookSize").value), space: $("cubeSpace").value, input: $("cubeInput").value }
      : { space: $("xmpSpace").value, input: $("xmpInput").value };
    const r = await client.exportLook(params, kind, opts);
    download(new Blob([r.text], { type: "text/plain" }), r.name);
    status(`저장: ${r.name}`, "done");
  } catch (e) {
    status(e.message, "error");
  }
}

function lock(on) {
  document.body.classList.toggle("busy", on);
  for (const b of document.querySelectorAll("button, input[type=file]")) b.disabled = on;
}

// ── 패널 ─────────────────────────────────────────────────────────────────

function changed(path, value, live) {
  P.set(params, path, value);
  for (const r of refreshers) if (r.dependsOn) r();
  store.set(STORE_CURRENT, params);
  render(live);
}

function fmt(c, v) {
  const digits = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : 2;
  let s = Number(v).toFixed(digits);
  if (c.signed && v > 0) s = "+" + s;
  if (!c.unit) return s;
  return c.prefixUnit ? `${c.unit} ${s}` : `${s}${c.unit === "스톱" ? " " : ""}${c.unit}`;
}

/** 로그 슬라이더(감도) — 위치 0~1000 ↔ 값. 한 스톱이 같은 거리를 차지한다. */
const logPos = (c, v) => Math.round((Math.log(v / c.min) / Math.log(c.max / c.min)) * 1000);
const logVal = (c, p) => Math.round(c.min * Math.pow(c.max / c.min, p / 1000));

function buildRange(c, getPath) {
  const path = () => (typeof getPath === "function" ? getPath() : c.path);
  const out = el("output");
  const input = el("input", c.log
    ? { type: "range", min: 0, max: 1000, step: 1 }
    : { type: "range", min: c.min, max: c.max, step: c.step });
  const read = () => (c.log ? logVal(c, Number(input.value)) : Number(input.value));
  const show = (v) => { out.textContent = fmt(c, v); };
  input.addEventListener("input", () => { show(read()); changed(path(), read(), true); });
  input.addEventListener("change", () => changed(path(), read(), false));
  const label = el("span", { class: "name", text: c.label, title: "두 번 눌러 기본값으로" });
  const reset = () => {
    const d = P.get(DEFAULTS, path());
    if (d == null) return;
    changed(path(), d, false);
    refresh();
  };
  label.addEventListener("dblclick", reset);
  const refresh = () => {
    const v = P.get(params, path());
    const n = v == null ? P.get(DEFAULTS, path()) : v;
    input.value = c.log ? logPos(c, Math.min(c.max, Math.max(c.min, n))) : n;
    show(n);
  };
  refreshers.push(refresh);
  return wrap(c, el("label", { class: "row range" }, el("span", { class: "head" }, label, out), input));
}

function buildSelect(c) {
  const input = el("select", {}, ...c.options.map(([v, t]) => el("option", { value: v, text: t })));
  input.addEventListener("change", () => changed(c.path, c.number ? Number(input.value) : input.value, false));
  refreshers.push(() => { input.value = String(P.get(params, c.path)); });
  return wrap(c, el("label", { class: "row" }, el("span", { class: "name", text: c.label }), input));
}

function buildCheck(c) {
  const input = el("input", { type: "checkbox" });
  input.addEventListener("change", () => changed(c.path, input.checked, false));
  refreshers.push(() => { input.checked = !!P.get(params, c.path); });
  return wrap(c, el("label", { class: "row check" }, input, el("span", { text: c.label })));
}

function buildNumber(c) {
  const input = el("input", { type: "number", min: c.min, max: c.max, step: c.step, inputmode: "numeric" });
  input.addEventListener("change", () => changed(c.path, Number(input.value), false));
  refreshers.push(() => { input.value = P.get(params, c.path); });
  return wrap(c, el("label", { class: "row" }, el("span", { class: "name", text: c.label }), input));
}

/** 색역별 보정 — 색역을 고르면 그 색역의 C·M·Y·K 넷이 나온다. 슬라이더 40개를 늘어놓지 않는다. */
function buildSelective(c) {
  const pick = el("select", {}, ...c.ranges.map(([v, t]) => el("option", { value: v, text: t })));
  const box = el("div", { class: "group" }, el("label", { class: "row" }, el("span", { class: "name", text: c.label }), pick));
  const start = refreshers.length;
  for (const [key, label] of [["c", "시안"], ["m", "마젠타"], ["y", "옐로"], ["k", "블랙"]]) {
    box.append(buildRange({ label, min: -100, max: 100, step: 1, signed: true }, () => `grading.selectiveColor.${pick.value}.${key}`));
  }
  const mine = refreshers.slice(start);
  const mark = () => {
    for (const o of pick.options) {
      const v = params.grading.selectiveColor[o.value] || {};
      const touched = v.c || v.m || v.y || v.k;
      o.textContent = c.ranges.find((r) => r[0] === o.value)[1] + (touched ? " ●" : "");
    }
  };
  mark.dependsOn = true;
  refreshers.push(mark);
  pick.addEventListener("change", () => mine.forEach((r) => r()));
  return box;
}

/** `when` — 다른 값에 따라 숨는 컨트롤. 꺼진 기능의 손잡이는 보이지 않는 편이 낫다. */
function wrap(c, node) {
  if (c.hint) node.append(el("small", { text: c.hint }));
  if (c.when) {
    const test = typeof c.when === "function" ? c.when : (p) => !!P.get(p, c.when);
    const update = () => { node.hidden = !test(params); };
    update.dependsOn = true;
    refreshers.push(update);
  }
  return node;
}

function buildPanel() {
  const panel = $("sections");
  for (const s of SECTIONS) {
    const body = el("div", { class: "body" });
    if (s.hint) body.append(el("p", { class: "hint", text: s.hint }));
    for (const c of s.items) {
      body.append(
        c.type === "range" ? buildRange(c)
        : c.type === "select" ? buildSelect(c)
        : c.type === "check" ? buildCheck(c)
        : c.type === "number" ? buildNumber(c)
        : buildSelective(c)
      );
    }
    const summary = el("summary", {}, el("span", { text: s.title }));
    if (s.enable) {
      const toggle = el("input", { type: "checkbox", title: "켜기/끄기" });
      toggle.addEventListener("click", (e) => e.stopPropagation());
      toggle.addEventListener("change", () => changed(s.enable, toggle.checked, false));
      const sync = () => {
        toggle.checked = P.get(params, s.enable) !== false;
        body.classList.toggle("off", !toggle.checked);
      };
      sync.dependsOn = true;
      refreshers.push(sync);
      summary.append(toggle);
    }
    panel.append(el("details", { open: s.open === true, id: `sec-${s.id}` }, summary, body));
  }
}

function refreshAll() {
  for (const r of refreshers) r();
}

// ── 프리셋 ───────────────────────────────────────────────────────────────

let presets = [];

function loadPresets() {
  const saved = store.get(STORE_PRESETS);
  presets = Array.isArray(saved) && saved.length ? saved.map(P.migrate) : P.seeds();
}

function fillPresetList(selected) {
  const sel = $("presetList");
  sel.replaceChildren(
    el("option", { value: "", text: "프리셋…" }),
    ...presets.map((p, i) => el("option", { value: i, text: p.category ? `${p.category} / ${p.name}` : p.name }))
  );
  sel.value = selected == null ? "" : String(selected);
}

function applyParams(next) {
  params = P.migrate(next);
  store.set(STORE_CURRENT, params);
  refreshAll();
  render(false);
}

function bindPresets() {
  loadPresets();
  fillPresetList();
  $("presetList").addEventListener("change", (e) => {
    if (e.target.value === "") return;
    applyParams(JSON.parse(JSON.stringify(presets[Number(e.target.value)])));
    status(`프리셋: ${params.name}`);
  });
  $("presetSave").addEventListener("click", () => {
    const name = prompt("프리셋 이름", params.name && params.name !== "Untitled" ? params.name : "");
    if (!name) return;
    params.name = name.trim();
    const copy = JSON.parse(JSON.stringify(params));
    const at = presets.findIndex((p) => p.name === copy.name);
    if (at >= 0) presets[at] = copy; else presets.push(copy);
    store.set(STORE_PRESETS, presets);
    fillPresetList(at >= 0 ? at : presets.length - 1);
    status(`프리셋 저장: ${copy.name}`, "done");
  });
  $("presetDelete").addEventListener("click", () => {
    const i = $("presetList").value;
    if (i === "" || !confirm(`「${presets[Number(i)].name}」 프리셋을 지울까요?`)) return;
    presets.splice(Number(i), 1);
    store.set(STORE_PRESETS, presets);
    fillPresetList();
  });
  $("presetExport").addEventListener("click", () => {
    const slug = (params.name || "preset").replace(/[\\/:*?"<>|]/g, "").trim() || "preset";
    download(new Blob([JSON.stringify(params, null, 2)], { type: "application/json" }), `${slug}.json`);
  });
  $("presetImport").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      // Photoshop 엔진·마감 플러그인의 프리셋도 그대로 읽힌다 — 없는 쪽은 기본값
      applyParams(JSON.parse(await file.text()));
      status(`프리셋 불러옴: ${params.name}`, "done");
    } catch (err) {
      status("프리셋 파일을 읽을 수 없습니다 — JSON이 아닙니다", "error");
    }
  });
  $("resetAll").addEventListener("click", () => {
    applyParams({});
    fillPresetList();
    status("기본값으로 되돌림");
  });
}

// ── 시작 ─────────────────────────────────────────────────────────────────

function bindFiles() {
  const pick = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
  $("fileOpen").addEventListener("change", pick);
  $("fileOpen2").addEventListener("change", pick);
  $("fileBatch").addEventListener("change", (e) => { const fs = Array.from(e.target.files); e.target.value = ""; exportBatch(fs); });
  $("btnExport").addEventListener("click", exportCurrent);
  $("btnCube").addEventListener("click", () => exportLook("cube"));
  $("btnXmp").addEventListener("click", () => exportLook("xmp"));

  window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drop"); });
  window.addEventListener("dragleave", () => document.body.classList.remove("drop"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("drop");
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  const sync = () => {
    $("expQualityRow").hidden = $("expFormat").value !== "jpeg";
    $("expEdgeCustom").hidden = $("expEdge").value !== "custom";
    $("expQualityOut").textContent = $("expQuality").value;
  };
  for (const id of ["expFormat", "expEdge", "expQuality"]) $(id).addEventListener("input", sync);
  sync();

  const fill = (id, list) => $(id).replaceChildren(...list.map(([v, t]) => el("option", { value: v, text: t })));
  fill("lookSize", cube.SIZES.map((n) => [n, `${n}³`]));
  fill("cubeSpace", cube.SPACES.map((s) => [s.id, s.displayName]));
  fill("cubeInput", cube.INPUTS.map((s) => [s.id, s.displayName]));
  fill("xmpSpace", Object.entries(xmp.SPACES).map(([id, s]) => [id, s.displayName]));
  fill("xmpInput", xmp.XMP_INPUTS.map((s) => [s.id, s.displayName]));
}

function start() {
  buildPanel();
  bindViewer();
  bindFiles();
  bindPresets();
  refreshAll();
  $("about").textContent =
    `FilmSim Studio ${VERSION} · 필름 ${films.all().length}종 · ` + (client.threaded ? "백그라운드 처리" : "단일 스레드(이 브라우저는 워커를 못 씁니다 — 처리 중 화면이 멎습니다)");
  status("사진을 여세요 — JPEG · PNG · WebP · TIFF(8/16비트)");

  // 설치형(PWA)은 https나 localhost에서만 된다. 파일로 직접 열었으면 조용히 건너뛴다
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
