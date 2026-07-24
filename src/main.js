/**
 * 패널 부트스트랩. UI ↔ 파라미터 모델 양방향 바인딩과 액션 배선을 담당한다.
 */

// UXP는 <script src>로 로드된 스크립트의 require를 스크립트 위치가 아니라
// 플러그인 루트 기준으로 해석한다. 따라서 진입 모듈만 경로에 src/를 붙인다.
// 하위 모듈끼리의 require는 각자의 폴더 기준으로 정상 해석된다.
const {
  defaultParams,
  migrate,
  crosstalkMatrixFromAmount,
  crosstalkAmountFromMatrix,
} = require("./src/params");
const pipeline = require("./src/pipeline");
const presets = require("./src/presets");
const batch = require("./src/batch");
const preview = require("./src/preview");
const simulate = require("./src/simulate");
const colorwheel = require("./src/colorwheel");
const cslider = require("./src/cslider");
const { entrypoints } = require("uxp");

// 두 패널(메인/미리보기)을 등록한다. 같은 JS 컨텍스트를 공유하므로 main.js가
// 두 패널의 DOM을 그대로 제어한다. show() 훅에서 각 컨테이너를 패널 노드로 옮긴다.
// show(event)의 event가 곧 패널 컨테이너 노드다(event.node가 아니라 event 자체).
// 각 패널의 콘텐츠 div를 그 패널 노드로 옮긴다.
entrypoints.setup({
  panels: {
    "filmsim.main": {
      show(event) {
        const el = document.getElementById("mainPanel");
        if (el && event && event.appendChild) event.appendChild(el);
      },
    },
    "filmsim.preview": {
      show(event) {
        const el = document.getElementById("previewPanel");
        if (el && event && event.appendChild) event.appendChild(el);
      },
    },
  },
});

let sliders = {}; // 커스텀 슬라이더 컨트롤러 맵 (id → controller)

let params = defaultParams();
let presetIndex = []; // [{ fileName, params }]
let busy = false;
let previewTimer = null;

const $ = (id) => document.getElementById(id);

// 팔레트 미리보기용 대표 색. 필름 룩에서 판단이 중요한 톤들.
// 스킨 3단계 · 하늘/잎 · 원색 R/G/B · 보색 C/M/Y · 무채색 3단계.
const PALETTE = [
  [242, 202, 178], // 밝은 스킨
  [214, 156, 128], // 중간 스킨
  [150, 96, 78],   // 어두운 스킨
  [118, 170, 210], // 하늘
  [96, 150, 84],   // 잎
  [206, 60, 52],   // 레드
  [70, 160, 92],   // 그린
  [64, 96, 190],   // 블루
  [70, 178, 188],  // 시안
  [190, 74, 168],  // 마젠타
  [226, 200, 74],  // 옐로
  [38, 38, 40],    // 근암부
  [128, 128, 130], // 중간회색
  [212, 214, 216], // 근명부
  [250, 250, 250], // 화이트
];

// 큰 컬러휠에는 유채색만 얹는다(무채색은 중심에 뭉쳐 못 고르므로 미니휠로 분리).
const COLOR_PALETTE = PALETTE.slice(0, 11);

// 무채색 미니휠 색역과 대표 밝기(0~1). CMY 역매핑 기준.
const ACHROMA_TONE = { whites: 0.88, neutrals: 0.5, blacks: 0.22 };
let miniWheels = {};

// 시각화(팔레트 + 컬러휠)는 조작이 멈춘 뒤에만 갱신한다.
//
// 조작 중 매 input마다 팔레트 div 15개의 style이나 canvas를 다시 그리면, UXP가
// 이를 native UI로 매핑하는 비용(JS 시간엔 안 잡힌다)이 렌더 파이프를 오버로드해
// 버벅임과 블랙아웃을 만든다. 그래서 조작 중에는 슬라이더 핸들 이동 외에 아무것도
// 그리지 않고, 디바운스로 조작이 멈춘 순간에 팔레트·컬러휠을 한 번에 갱신한다.
// 시각화(팔레트 + DOM 컬러휠)는 실시간으로 갱신하되 rAF로 프레임당 1회만 그린다.
// 컬러휠이 DOM이라 canvas처럼 검게 클리어되지 않아 조작 중에도 안전하고,
// transform 기반 마커 갱신은 합성 레이어라 가볍다.
let renderPending = false;

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderPalette();
    renderWheel();
  });
}

/**
 * 파라미터가 바뀔 때마다 호출된다. 팔레트·컬러휠을 실시간 갱신(rAF 코얼레싱)하고
 * 프록시 미리보기는 디바운스한다.
 */
function onParamsChanged() {
  schedulePreviewRefresh();
  scheduleRender();
}

let wheelCtrl = null;

/** 컬러휠 마커·화살표를 갱신한다 (DOM transform). 배경은 build에서 1회 구성됨. */
function renderWheel() {
  if (!wheelCtrl) return;
  try {
    wheelCtrl.update(COLOR_PALETTE, params.grading);
  } catch (e) {
    console.error("wheel update 실패", e);
  }
}

/** 색을 Selective Color 색역 중 하나로 분류한다. */
function classifyRange(rgb) {
  const { h, s, v } = colorwheel.rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (s < 0.22) {
    if (v > 0.7) return "whites";
    if (v < 0.35) return "blacks";
    return "neutrals";
  }
  const bands = [
    ["reds", 0], ["yellows", 60], ["greens", 120],
    ["cyans", 180], ["blues", 240], ["magentas", 300],
  ];
  let best = "reds";
  let bd = 999;
  for (const [name, bh] of bands) {
    let d = Math.abs(h - bh) % 360;
    if (d > 180) d = 360 - d;
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

/**
 * 컬러휠 마커를 드래그하면 호출된다. 마커 색이 속한 색역을 자동 판정해 그 색역의
 * CMY를 조절하고, scRange를 그 색역으로 전환한다. 드래그로 잡은 목표 색조/채도와
 * 원본색의 차이를 CMY 델타로 역매핑한다(방향성 근사). 정확한 결과는 팔레트·휠·
 * 프록시 미리보기의 실시간 피드백을 보며 맞춘다.
 */
const MARKER_GAIN = 1.4; // 마커 드래그 CMY 조절 강도 배율

function handleMarkerDrag(index, targetHue, targetSat) {
  const rgb = COLOR_PALETTE[index];
  const src = colorwheel.rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const range = classifyRange(rgb);
  // 방향(색조)의 최대채도색을 기준으로 CMY 델타 방향을 잡는다. 밝기에 하한(0.55)을
  // 둬 어두운 색도 충분한 색공간을 확보한다(원본 밝기를 그대로 쓰면 어두운 색은
  // 도달 범위가 극히 좁아진다). 강도는 드래그 거리(targetSat, 휠 밖이면 >1)로 키운다.
  const v = Math.max(src.v, 0.55);
  const dir = colorwheel.hsvToRgb(targetHue, 1, v);
  const s = targetSat * MARKER_GAIN;
  const c100 = (x) => Math.max(-100, Math.min(100, Math.round(x)));
  // 잉크 증가 = 채널 감소. 방향색이 더 어두운(적은) 채널일수록 그 잉크를 늘린다.
  const dc = c100(((rgb[0] - dir[0]) / 2.55) * s);
  const dm = c100(((rgb[1] - dir[1]) / 2.55) * s);
  const dy = c100(((rgb[2] - dir[2]) / 2.55) * s);

  params.grading.enabled = true;
  params.grading.selectiveColor[range] = { c: dc, m: dm, y: dy, k: 0 };
  $("gradingEnabled").checked = true;
  setRange(range); // 색역 자동 선택 (칩 하이라이트 + 슬라이더 반영)
  onParamsChanged();
}

/**
 * 무채색 미니휠 드래그 → 그 톤 색역(whites/neutrals/blacks)에 색조를 부여한다.
 * 톤의 대표 밝기 기준으로 목표색을 만들고 CMY 델타를 역산한다.
 */
function handleAchromaDrag(range, hue, sat) {
  const v = ACHROMA_TONE[range];
  const base = v * 255;
  // 무채색은 미묘한 색조가 자연스러우므로 채도를 절반으로 완화한다.
  const target = colorwheel.hsvToRgb(hue, sat * 0.5, v);
  const c100 = (x) => Math.max(-100, Math.min(100, Math.round(x)));
  const dc = c100((base - target[0]) / 2.55);
  const dm = c100((base - target[1]) / 2.55);
  const dy = c100((base - target[2]) / 2.55);

  params.grading.enabled = true;
  params.grading.selectiveColor[range] = { c: dc, m: dm, y: dy, k: 0 };
  $("gradingEnabled").checked = true;
  setRange(range);
  onParamsChanged();
}

/** 색역 조정을 기본값(0)으로 리셋한다. */
function resetRange(range) {
  params.grading.selectiveColor[range] = { c: 0, m: 0, y: 0, k: 0 };
  setRange(range);
  onParamsChanged();
}

/** 컬러휠 마커 더블탭 → 그 색의 색역 리셋. */
function handleMarkerReset(index) {
  resetRange(classifyRange(COLOR_PALETTE[index]));
}

/** 무채색 미니휠 더블탭 → 그 톤 색역 리셋 (마커 복귀는 buildMini가 처리). */
function handleAchromaReset(range) {
  resetRange(range);
}

/** 컬러휠 탭 전환 (컬러/무채색). */
function switchWheelView(view) {
  $("wheel").style.display = view === "color" ? "block" : "none";
  $("wheelAchroma").style.display = view === "achroma" ? "flex" : "none";
  document.querySelectorAll(".wtab").forEach((t) => {
    t.className = t.dataset.view === view ? "wtab active" : "wtab";
  });
}

/** 팔레트 스와치 div를 최초 1회 생성한다. 이후엔 style만 갱신한다. */
function buildPalette() {
  const el = $("palette");
  if (!el) return;
  el.innerHTML = "";
  for (let i = 0; i < PALETTE.length; i++) {
    const div = document.createElement("div");
    div.className = "swatch";
    el.appendChild(div);
  }
}

/**
 * 팔레트 스와치 배경만 갱신한다 (div 재생성 없이 in-place).
 * DOM 생성 비용을 피해 매 갱신을 가볍게 한다.
 */
function renderPalette() {
  const el = $("palette");
  if (!el) return;
  const swatches = el.children;
  if (swatches.length !== PALETTE.length) buildPalette();
  for (let i = 0; i < PALETTE.length; i++) {
    const rgb = PALETTE[i];
    const graded = simulate.applyGrading(rgb, params.grading);
    const orig = `rgb(${rgb.join(",")})`;
    const done = `rgb(${graded.map(Math.round).join(",")})`;
    // 좌상 원본 / 우하 적용색 (::after가 대각 경계선을 얹는다)
    el.children[i].style.background = `linear-gradient(118deg, ${orig} 0 48%, ${done} 52% 100%)`;
  }
}

/**
 * 파라미터가 바뀌면 패널 미리보기를 디바운스 갱신한다. 실제 사진 썸네일에
 * grading을 적용하는 픽셀 렌더(~90ms)라 조작이 멈춘 뒤(250ms) 한 번만 돈다.
 * (preview.render 내부에서 렌더 중 요청을 coalescing한다)
 */
function schedulePreviewRefresh() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    preview.render(params);
  }, 250);
}

function setStatus(message, isError = false) {
  const el = $("status");
  el.textContent = message || "";
  el.className = isError ? "error" : "";
  if (isError && message) console.error(message);
}

function setBusy(value) {
  busy = value;
  for (const id of ["btnApply", "btnBatch", "btnSavePreset", "btnDeletePreset"]) {
    $(id).disabled = value;
  }
}

/* ---------------------------------------------------------------- 바인딩 */

/** 커스텀 슬라이더 → 모델. path는 params 기준 점 표기. */
function bindSlider(id, path) {
  const ctrl = sliders[id];
  if (!ctrl) return;
  ctrl.onChange((v) => {
    setByPath(params, path, v);
    onParamsChanged();
  });
}

function bindCheckbox(id, path, invert = false) {
  const el = $(id);
  el.addEventListener("change", () => {
    setByPath(params, path, invert ? !el.checked : el.checked);
    onParamsChanged();
  });
}

function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]];
  cursor[keys[keys.length - 1]] = value;
}

function getByPath(obj, path) {
  return path.split(".").reduce((cursor, key) => cursor[key], obj);
}

/** 모델 → UI 전체 반영. 프리셋 로드 후 호출한다. */
function syncUI() {
  $("presetName").value = params.name === "Untitled" ? "" : params.name;

  $("gradingEnabled").checked = params.grading.enabled;
  setSlider("toe", params.grading.toe);
  setSlider("shoulder", params.grading.shoulder);
  syncSelectiveColorSliders();

  const h = params.halation;
  $("halationEnabled").checked = h.enabled;
  setSlider("halThreshold", h.threshold);
  setSlider("halStrength", h.strength);
  setSlider("halRadius", h.radius);
  setSlider("halHue", h.tintHue);
  setSlider("halSat", h.tintSaturation);

  const ct = params.grading.crosstalk;
  $("crosstalkEnabled").checked = ct.enabled;
  // 저장된 매트릭스에서 대표 강도를 역산해 슬라이더에 표시한다.
  ct.amount = crosstalkAmountFromMatrix(ct.matrix);
  setSlider("crosstalkAmount", ct.amount);

  const g = params.grain;
  $("grainEnabled").checked = g.enabled;
  setSlider("grainShadow", g.shadow);
  setSlider("grainMid", g.midtone);
  setSlider("grainHigh", g.highlight);
  setSlider("grainSize", g.size);
  setSlider("grainFeather", g.feather);
  $("grainColor").checked = g.colorMode === "rgb";
}

/** 커스텀 슬라이더 값을 프로그램적으로 설정한다 (통지 없음). */
function setSlider(id, value) {
  if (sliders[id]) sliders[id].setValue(value);
}

/* ------------------------------------------------- Selective Color 편집기 */

let currentRangeVal = "reds";

function currentRange() {
  return currentRangeVal;
}

/** 색역을 전환한다: 상태·칩 하이라이트·슬라이더 표시를 함께 갱신한다. */
function setRange(range) {
  currentRangeVal = range;
  updateRangeChips();
  syncSelectiveColorSliders();
}

function updateRangeChips() {
  const chips = document.querySelectorAll("#scRange .chip-btn");
  for (const c of chips) {
    // classList가 UXP에서 불안정할 수 있어 className을 직접 세팅한다.
    c.className = c.dataset.range === currentRangeVal ? "chip-btn active" : "chip-btn";
  }
}

function syncSelectiveColorSliders() {
  const v = params.grading.selectiveColor[currentRange()];
  setSlider("scC", v.c);
  setSlider("scM", v.m);
  setSlider("scY", v.y);
  setSlider("scK", v.k);
}

function bindSelectiveColorSlider(id, key) {
  const ctrl = sliders[id];
  if (!ctrl) return;
  ctrl.onChange((v) => {
    params.grading.selectiveColor[currentRange()][key] = v;
    onParamsChanged();
  });
}

/* ------------------------------------------------------------- 프리셋 UI */

async function refreshPresetList() {
  presetIndex = await presets.list();
  const menu = $("presetMenu");
  menu.innerHTML = "";

  for (let i = 0; i < presetIndex.length; i++) {
    const item = document.createElement("sp-menu-item");
    item.setAttribute("value", String(i));
    const entry = presetIndex[i];
    item.textContent = entry.params.category
      ? `${entry.params.category} — ${entry.params.name}`
      : entry.params.name;
    menu.appendChild(item);
  }
}

function loadPresetByIndex(index) {
  const entry = presetIndex[index];
  if (!entry) return;
  params = migrate(entry.params);
  syncUI();
  onParamsChanged();
  setStatus(`"${params.name}" 불러옴`);
}

/* ---------------------------------------------------------------- 액션 */

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
  setStatus("원본 폴더를 선택하세요…");
  try {
    const result = await batch.runBatch(
      params,
      {
        recursive: $("batchRecursive").checked,
        format: $("batchFormat").value || "jpg",
        quality: 10,
        suffix: $("batchSuffix").value || "",
      },
      (done, total, name) => {
        setStatus(name ? `${done + 1}/${total} · ${name}` : `${total}장 처리 완료`);
      }
    );

    if (!result) {
      setStatus("취소됨");
    } else if (result.failed.length > 0) {
      setStatus(
        `${result.succeeded}/${result.total} 성공, ${result.failed.length}장 실패 ` +
          `(${result.failed.map((f) => f.file).join(", ")})`,
        true
      );
    } else {
      setStatus(`${result.succeeded}장 모두 완료`);
    }
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    setBusy(false);
  }
}

async function onSavePreset() {
  const name = ($("presetName").value || "").trim();
  if (!name) {
    setStatus("프리셋 이름을 입력하세요.", true);
    return;
  }
  try {
    params.name = name;
    await presets.save(params);
    await refreshPresetList();
    setStatus(`"${name}" 저장됨`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

async function onDeletePreset() {
  const index = Number($("presetPicker").value);
  const entry = presetIndex[index];
  if (!entry) {
    setStatus("삭제할 프리셋을 선택하세요.", true);
    return;
  }
  try {
    await presets.remove(entry.fileName);
    await refreshPresetList();
    $("presetPicker").value = "";
    setStatus(`"${entry.params.name}" 삭제됨`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

/* ---------------------------------------------------------------- 초기화 */

function wire() {
  // 모든 커스텀 슬라이더를 먼저 초기화한다. 이후 bindSlider들이 sliders[id]를 참조한다.
  sliders = cslider.initAll(document);

  // 색역 칩 선택 → 색역 전환. click은 UXP div에서 불안정하므로 pointerdown을 쓴다
  // (슬라이더·마커에서 검증된 이벤트). 클릭된 요소는 currentTarget에서 읽는다.
  const chips = document.querySelectorAll("#scRange .chip-btn");
  chips.forEach((c) => {
    c.addEventListener("pointerdown", (e) => setRange(e.currentTarget.dataset.range));
  });

  // 컬러휠 탭 (컬러/무채색)
  document.querySelectorAll(".wtab").forEach((t) => {
    t.addEventListener("pointerdown", (e) => switchWheelView(e.currentTarget.dataset.view));
  });
  bindSelectiveColorSlider("scC", "c");
  bindSelectiveColorSlider("scM", "m");
  bindSelectiveColorSlider("scY", "y");
  bindSelectiveColorSlider("scK", "k");

  bindSlider("toe", "grading.toe");
  bindSlider("shoulder", "grading.shoulder");
  bindCheckbox("gradingEnabled", "grading.enabled");

  bindCheckbox("crosstalkEnabled", "grading.crosstalk.enabled");
  // 크로스토크 강도 슬라이더는 amount를 세팅하는 동시에 대칭 매트릭스를 파생한다.
  if (sliders.crosstalkAmount) {
    sliders.crosstalkAmount.onChange((amount) => {
      params.grading.crosstalk.amount = amount;
      params.grading.crosstalk.matrix = crosstalkMatrixFromAmount(amount);
      // 강도를 올리면 크로스토크를 자동 활성화한다.
      const enabled = amount > 0;
      params.grading.crosstalk.enabled = enabled;
      $("crosstalkEnabled").checked = enabled;
      onParamsChanged();
    });
  }

  bindSlider("halThreshold", "halation.threshold");
  bindSlider("halStrength", "halation.strength");
  bindSlider("halRadius", "halation.radius");
  bindSlider("halHue", "halation.tintHue");
  bindSlider("halSat", "halation.tintSaturation");
  bindCheckbox("halationEnabled", "halation.enabled");

  bindSlider("grainShadow", "grain.shadow");
  bindSlider("grainMid", "grain.midtone");
  bindSlider("grainHigh", "grain.highlight");
  bindSlider("grainSize", "grain.size");
  bindSlider("grainFeather", "grain.feather");
  bindCheckbox("grainEnabled", "grain.enabled");
  $("grainColor").addEventListener("change", () => {
    params.grain.colorMode = $("grainColor").checked ? "rgb" : "mono";
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

async function init() {
  wire();
  syncUI();
  wheelCtrl = colorwheel.build($("wheel"), {
    onMarkerDrag: handleMarkerDrag,
    onMarkerReset: handleMarkerReset,
  });
  miniWheels = {
    whites: colorwheel.buildMini($("miniWhites"), {
      onDrag: (h, s) => handleAchromaDrag("whites", h, s),
      onReset: () => handleAchromaReset("whites"),
    }),
    neutrals: colorwheel.buildMini($("miniNeutrals"), {
      onDrag: (h, s) => handleAchromaDrag("neutrals", h, s),
      onReset: () => handleAchromaReset("neutrals"),
    }),
    blacks: colorwheel.buildMini($("miniBlacks"), {
      onDrag: (h, s) => handleAchromaDrag("blacks", h, s),
      onReset: () => handleAchromaReset("blacks"),
    }),
  };
  buildPalette();
  renderWheel();
  renderPalette();
  try {
    await presets.seedIfEmpty();
    await refreshPresetList();
  } catch (e) {
    setStatus(`프리셋 초기화 실패: ${e.message || e}`, true);
  }
  preview.render(params); // 초기 미리보기 (문서 있으면)
}

init();
