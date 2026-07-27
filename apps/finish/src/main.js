/**
 * 마감 플러그인 부트스트랩 — 매체·할레이션·그레인.
 *
 * **색 로직이 없다.** `lib/`에 `core/color`가 아예 반입되지 않으므로
 * (tools/sync-libs.js) 여기서 필름이나 그레이딩을 건드릴 방법이 물리적으로 없다.
 * 색이 필요하면 엔진 플러그인을 쓴다.
 */

const { defaultParams, migrate } = require("./src/params");
const pipeline = require("./src/pipeline");
const presets = require("./src/presets");
const batch = require("./src/batch");
const cslider = require("./lib/shared/ui/cslider");
const format = require("./lib/core/optics/format");
const { entrypoints } = require("uxp");

let params = defaultParams();
let busy = false;
let presetIndex = [];
let sliders = {};

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "status error" : "status";
}

function setBusy(value) {
  busy = value;
  for (const id of ["btnApply", "btnBatch", "btnSavePreset", "btnDeletePreset"]) {
    const el = $(id);
    if (el) el.disabled = value;
  }
}

function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]];
  cursor[keys[keys.length - 1]] = value;
}

function onParamsChanged() {
  syncMediumUI();
}

// ── 매체 ────────────────────────────────────────────────────────────────

/** 포맷·기준 해상도 칩. UXP에서 sp-picker는 value를 읽고 쓸 수 없어 div로 만든다. */
function buildMediumChips() {
  const fHost = $("formatChips");
  if (fHost) {
    fHost.textContent = "";
    for (const f of format.all()) {
      const chip = document.createElement("div");
      chip.className = "chip-btn";
      chip.textContent = f.displayName;
      chip.dataset.formatId = f.id;
      chip.addEventListener("click", () => {
        params.medium.format = f.id;
        syncMediumUI();
      });
      fHost.appendChild(chip);
    }
  }
  const rHost = $("referenceChips");
  if (rHost) {
    rHost.textContent = "";
    for (const r of format.references()) {
      const chip = document.createElement("div");
      chip.className = "chip-btn";
      chip.textContent = r.displayName;
      chip.dataset.referenceId = r.id;
      chip.addEventListener("click", () => {
        params.medium.reference = r.id;
        syncMediumUI();
      });
      rHost.appendChild(chip);
    }
  }
}

/**
 * 매체 카드 갱신. 선택 상태와 함께 **실제 입자 크기를 픽셀로 보여준다** —
 * 포맷을 바꿨을 때 무엇이 달라지는지가 숫자로 보이지 않으면 고를 근거가 없다.
 */
function syncMediumUI() {
  if (!params.medium) params.medium = { format: "35mm", reference: "document", customLongEdge: 2048 };
  const m = params.medium;

  for (const [id, key] of [["formatChips", "formatId"], ["referenceChips", "referenceId"]]) {
    const host = $(id);
    if (!host) continue;
    const want = key === "formatId" ? m.format : m.reference;
    for (const chip of host.querySelectorAll(".chip-btn")) {
      chip.classList.toggle("active", chip.dataset[key] === want);
    }
  }

  // 직접 입력 칸은 그 기준일 때만 보인다.
  const row = $("customEdgeRow");
  if (row) row.style.display = m.reference === "custom" ? "flex" : "none";
  const edge = $("customEdge");
  if (edge && String(m.customLongEdge) !== String(edge.value)) edge.value = m.customLongEdge;

  const note = $("mediumNote");
  if (!note) return;
  const parts = [format.byId(m.format).note];
  let doc = null;
  try {
    doc = require("photoshop").app.activeDocument;
  } catch (e) {
    doc = null;
  }
  if (doc) {
    const s = format.grainSize(doc, m, params.grain.iso);
    const px = s.px < 1 ? s.px.toFixed(2) : s.px.toFixed(1);
    parts.push(
      `ISO ${params.grain.iso} · 입자 ~${s.microns.toFixed(0)}µm → ${px}px` +
        (s.subPixel ? " (1px 미만 — 블러 대신 강도로 환산)" : "")
    );
    parts.push(format.printSize(doc));
  }
  note.textContent = parts.join("  /  ");
}

// ── UI 바인딩 ───────────────────────────────────────────────────────────

function setSlider(id, value) {
  if (sliders[id]) sliders[id].setValue(value);
}

function bindSlider(id, path) {
  const ctrl = sliders[id];
  if (!ctrl) return;
  ctrl.onChange((v) => {
    setByPath(params, path, v);
    onParamsChanged();
  });
}

function bindCheckbox(id, path) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    setByPath(params, path, el.checked);
    onParamsChanged();
  });
}

function syncUI() {
  $("presetName").value = params.name === "Untitled" ? "" : params.name;

  const h = params.halation;
  $("halationEnabled").checked = h.enabled;
  setSlider("halThreshold", h.threshold);
  setSlider("halStrength", h.strength);
  setSlider("halRadius", h.radius);
  setSlider("halCore", h.core);
  setSlider("halMid", h.mid);
  setSlider("halBleed", h.bleed);
  setSlider("halDisk", h.disk);
  setSlider("halHue", h.tintHue);
  setSlider("halSat", h.tintSaturation);

  const g = params.grain;
  $("grainEnabled").checked = g.enabled;
  setSlider("grainShadow", g.shadow);
  setSlider("grainMid", g.midtone);
  setSlider("grainHigh", g.highlight);
  setSlider("grainSize", g.iso);
  setSlider("grainDiffusion", g.diffusion);
  setSlider("grainClump", g.clump);
  setSlider("grainDyeSpread", g.dyeSpread);
  setSlider("grainFeather", g.feather);
  $("grainColor").checked = g.colorMode === "rgb";
  $("grainDisplace").checked = !!g.diffuseDisplace;

  syncMediumUI();
}

// ── 프리셋 ──────────────────────────────────────────────────────────────

async function refreshPresetList() {
  try {
    presetIndex = await presets.list();
  } catch (e) {
    presetIndex = [];
  }
  const menu = $("presetMenu");
  if (!menu) return;
  menu.textContent = "";
  presetIndex.forEach((entry, i) => {
    const item = document.createElement("sp-menu-item");
    item.setAttribute("value", String(i));
    const cat = entry.params.category ? `${entry.params.category} · ` : "";
    item.textContent = `${cat}${entry.params.name}`;
    menu.appendChild(item);
  });
}

function loadPresetByIndex(index) {
  const entry = presetIndex[index];
  if (!entry) return;
  params = migrate(entry.params);
  syncUI();
  onParamsChanged();
  setStatus(`"${params.name}" 불러옴`);
}

async function onSavePreset() {
  const name = ($("presetName").value || "").trim();
  if (!name) return setStatus("프리셋 이름을 입력하세요.", true);
  params.name = name;
  try {
    await presets.save(params);
    await refreshPresetList();
    setStatus(`"${name}" 저장됨`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

async function onDeletePreset() {
  const name = ($("presetName").value || "").trim();
  const entry = presetIndex.find((p) => p.params.name === name);
  if (!entry) return setStatus("그 이름의 프리셋이 없습니다.", true);
  try {
    await presets.remove(entry.fileName);
    await refreshPresetList();
    setStatus(`"${name}" 삭제됨`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────

async function onApply() {
  if (busy) return;
  setBusy(true);
  setStatus("적용 중…");
  try {
    await pipeline.applyToActiveDocument(params);
    setStatus("적용 완료");
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    setBusy(false);
  }
}

async function onBatch() {
  if (busy) return;
  setBusy(true);
  try {
    const result = await batch.runBatch(
      params,
      {
        recursive: $("batchRecursive").checked,
        format: $("batchFormat").value || "jpg",
        quality: 10,
        suffix: $("batchSuffix").value || "",
      },
      (done, total, name) => setStatus(`${done}/${total} — ${name}`)
    );
    if (!result) return setStatus("취소됨");
    const fail = result.failed.length ? ` / 실패 ${result.failed.length}` : "";
    setStatus(`${result.succeeded}/${result.total} 완료${fail}`, result.failed.length > 0);
    if (result.failed.length) console.error("배치 실패", result.failed);
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    setBusy(false);
  }
}

function wire() {
  // 슬라이더는 DOM에서 한 번에 초기화한다 (.cs 요소 스캔)
  sliders = cslider.initAll(document);

  bindSlider("halThreshold", "halation.threshold");
  bindSlider("halStrength", "halation.strength");
  bindSlider("halRadius", "halation.radius");
  bindSlider("halCore", "halation.core");
  bindSlider("halMid", "halation.mid");
  bindSlider("halBleed", "halation.bleed");
  bindSlider("halDisk", "halation.disk");
  bindSlider("halHue", "halation.tintHue");
  bindSlider("halSat", "halation.tintSaturation");
  bindCheckbox("halationEnabled", "halation.enabled");

  bindSlider("grainShadow", "grain.shadow");
  bindSlider("grainMid", "grain.midtone");
  bindSlider("grainHigh", "grain.highlight");
  bindSlider("grainSize", "grain.iso");
  bindSlider("grainDiffusion", "grain.diffusion");
  bindSlider("grainClump", "grain.clump");
  bindSlider("grainDyeSpread", "grain.dyeSpread");
  bindSlider("grainFeather", "grain.feather");
  bindCheckbox("grainEnabled", "grain.enabled");
  $("grainDisplace").addEventListener("change", () => {
    params.grain.diffuseDisplace = $("grainDisplace").checked;
    onParamsChanged();
  });
  $("grainColor").addEventListener("change", () => {
    params.grain.colorMode = $("grainColor").checked ? "rgb" : "mono";
    onParamsChanged();
  });

  // 직접 입력 긴 변. **원문 문자열을 그대로 저장한다.** Number로 강제하면 빈칸이
  // 0이 되고, syncMediumUI가 그 0을 필드에 다시 써넣어 타이핑을 방해한다.
  // 유효성(빈칸·하한 미만·NaN)은 format.longEdgeFor가 문서 값 폴백으로 흡수한다.
  $("customEdge").addEventListener("input", () => {
    params.medium.customLongEdge = $("customEdge").value;
    onParamsChanged();
  });

  $("presetPicker").addEventListener("change", (e) => {
    loadPresetByIndex(Number(e.target.value));
  });
  $("btnSavePreset").addEventListener("click", onSavePreset);
  $("btnDeletePreset").addEventListener("click", onDeletePreset);

  $("btnExport").addEventListener("click", async () => {
    try {
      const name = await presets.exportToFile(params);
      setStatus(name ? `${name} 내보냄` : "취소됨");
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  });

  $("btnImport").addEventListener("click", async () => {
    try {
      const imported = await presets.importFromFile();
      if (!imported) return setStatus("취소됨");
      params = imported;
      syncUI();
      onParamsChanged();
      await refreshPresetList();
      setStatus(`"${imported.name}" 가져옴`);
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  });

  $("btnApply").addEventListener("click", onApply);
  $("btnBatch").addEventListener("click", onBatch);
}

entrypoints.setup({
  panels: {
    "filmsim.finish": { show() {} },
  },
});

async function init() {
  wire();
  buildMediumChips();
  syncUI();
  try {
    await presets.seedIfEmpty();
  } catch (e) {
    console.error("프리셋 초기화 실패", e);
  }
  await refreshPresetList();

  // 문서가 바뀌면 입자 크기 표시가 달라진다 (문서 픽셀 기준이므로).
  try {
    const { action } = require("photoshop");
    action.addNotificationListener(
      [{ event: "select" }, { event: "open" }, { event: "newDocument" }, { event: "close" }],
      () => syncMediumUI()
    );
  } catch (e) {
    console.error("문서 전환 리스너 등록 실패", e);
  }
}

init();
