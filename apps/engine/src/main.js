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
const preview = require("./src/preview");
const simulate = require("./lib/core/color/simulate");
const colorwheel = require("./src/colorwheel");
const cslider = require("./lib/shared/ui/cslider");
const photoanalysis = require("./src/photoanalysis");
const films = require("./lib/core/color/films");
const scanner = require("./lib/core/color/scanner");
const film = require("./lib/core/color/film");
const lut = require("./lib/core/color/lut");
const colorspace = require("./lib/core/color/colorspace");
const gamut = require("./lib/core/color/gamut");
const cubeexport = require("./lib/core/io/cube");
const xmpexport = require("./lib/core/io/xmp");
const apply = require("./src/apply");
const exportfile = require("./src/exportfile");
const ps = require("./lib/host/ps");
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
    // 분포(벡터스코프). 별도 패널이라 사용자가 원하는 자리에 도킹·플로팅할 수 있다.
    "filmsim.scope": {
      show(event) {
        const el = document.getElementById("scopePanel");
        if (el && event && event.appendChild) event.appendChild(el);
        renderScope(); // 패널을 처음 열었을 때 바로 그린다
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

// 큰 컬러휠 마커는 유채 6색역에 1:1 대응한다. 마커 index가 곧 색역이다
// (드래그 시 classify 없이 이 순서로 색역을 정한다).
const CHROMA_ORDER = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];

// 사진 분석 실패/문서 없음 시 폴백 대표색 (각 색역 순색).
const FALLBACK_CHROMA = {
  reds: [200, 80, 70],
  yellows: [214, 184, 84],
  greens: [92, 162, 92],
  cyans: [78, 176, 182],
  blues: [78, 110, 200],
  magentas: [182, 90, 172],
};

// 사진 색역 분석 결과 (photoanalysis.analyze). null이면 폴백 사용.
let photoData = null;

/** 큰 컬러휠에 얹을 유채 6색역 대표색 배열 (사진 기반, 없으면 폴백). */
function getColorPalette() {
  return CHROMA_ORDER.map((r) => {
    const rep = photoData && photoData.ranges[r] && photoData.ranges[r].rep;
    return rep || FALLBACK_CHROMA[r];
  });
}

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
    renderDetail();
  });
}

/**
 * 파라미터가 바뀔 때마다 호출된다. 팔레트·컬러휠을 실시간 갱신(rAF 코얼레싱)하고
 * 프록시 미리보기는 디바운스한다.
 */
function onParamsChanged() {
  schedulePreviewRefresh();
  scheduleRender();
  syncCubeUI(); // 제안 파일명이 필름·스캐너·노광을 담고 있다
  syncFilmUI(); // 필름 on/off가 카드 설명(색 모드 ↔ 마감 모드)을 바꾼다
}

let wheelCtrl = null;
let detailCtrl = null;
// 세부 휠에 현재 얹혀 있는 톤 색 배열. 마커 index → 원본색 조회용(드래그).
let detailTones = [];

const RANGE_LABELS = {
  reds: "레드", yellows: "옐로", greens: "그린", cyans: "시안", blues: "블루",
  magentas: "마젠타", whites: "화이트", neutrals: "중간톤", blacks: "블랙",
};

/** 컬러휠 마커·화살표를 갱신한다 (DOM transform). 배경은 build에서 1회 구성됨. */
function renderWheel() {
  if (!wheelCtrl) return;
  try {
    // 기준색은 필름을 통과한 색이다. 휠은 그 위에서 색 조정이 색을 어디로
    // 미는지를 그린다 — 필름 룩을 고르고 그 위에서 손보는 순서와 같다.
    const t = visualTables().film;
    wheelCtrl.update(getColorPalette().map((c) => throughLut(c, t)), params.grading);
  } catch (e) {
    console.error("wheel update 실패", e);
  }
}

/**
 * 세부 휠: 현재 선택된 색역의 밝기별 대표색(tones)이 grading으로 어디로 이동하는지
 * 보여준다. 메인 휠은 색역당 대표 1개, 세부 휠은 그 색역 안을 밝기로 파고든다.
 */
function renderDetail() {
  if (!detailCtrl) return;
  const range = currentRange();
  let tones = [];
  if (photoData && photoData.ranges[range]) {
    tones = photoData.ranges[range].tones.filter(Boolean);
  }
  if (tones.length === 0) {
    const rep = (photoData && photoData.ranges[range] && photoData.ranges[range].rep) ||
      FALLBACK_CHROMA[range] || [128, 128, 128];
    tones = [rep];
  }
  detailTones = tones; // 세부 휠 드래그가 마커 index로 원본색을 찾는다
  try {
    const t = visualTables().film;
    detailCtrl.update(tones.map((c) => throughLut(c, t)), params.grading);
  } catch (e) {
    console.error("detail update 실패", e);
  }
  const label = $("detailLabel");
  if (label) label.textContent = "색역 세부 — " + (RANGE_LABELS[range] || range);
}

let lastAnalyzedDocId = "none";

function activeDocId() {
  const psApp = require("photoshop").app;
  return psApp.documents.length ? psApp.activeDocument.id : null;
}

/**
 * 활성 문서가 바뀌면 컬러휠 대표색과 미리보기를 새 문서 기준으로 갱신한다.
 * 같은 문서면 건너뛴다(문서 전환 시에만 재분석). force로 강제 갱신.
 */
async function refreshForActiveDoc(force) {
  const id = activeDocId();
  if (!force && id === lastAnalyzedDocId) return;
  lastAnalyzedDocId = id;
  try {
    photoData = await photoanalysis.analyze();
  } catch (e) {
    photoData = null;
    console.error("사진 분석 실패", e);
  }
  renderWheel();
  renderDetail();
  // 미리보기도 새 문서로 다시 그린다. 이게 빠지면 문서를 바꿔도 파라미터를
  // 건드리기 전까지 이전 사진이 그대로 남는다.
  await preview.render(params);
}

/**
 * 문서 알림 처리를 짧게 디바운스한다. 한 동작에 select/open이 여러 번 몰려 오고,
 * close는 문서 목록이 실제로 정리되기 전에 오기도 해서 곧바로 읽으면 닫히는
 * 문서를 활성 문서로 잘못 잡는다.
 */
let docCheckTimer = null;

function scheduleDocCheck() {
  if (docCheckTimer) clearTimeout(docCheckTimer);
  docCheckTimer = setTimeout(() => {
    docCheckTimer = null;
    refreshForActiveDoc(false);
  }, 150);
}

/**
 * 컬러휠 마커를 드래그하면 호출된다. 마커 색이 속한 색역을 자동 판정해 그 색역의
 * CMY를 조절하고, scRange를 그 색역으로 전환한다. 드래그로 잡은 목표 색조/채도와
 * 원본색의 차이를 CMY 델타로 역매핑한다(방향성 근사). 정확한 결과는 팔레트·휠·
 * 프록시 미리보기의 실시간 피드백을 보며 맞춘다.
 */
const MARKER_GAIN = 1.4; // 마커 드래그 CMY 조절 강도 배율

function handleMarkerDrag(index, targetHue, targetSat) {
  // 마커 index가 곧 색역이다(사진 대표색을 다시 classify하면 경계에서 어긋날 수
  // 있으므로 순서로 직접 정한다).
  applyMarkerDrag(CHROMA_ORDER[index], getColorPalette()[index], targetHue, targetSat);
}

/**
 * 세부 휠 마커 드래그. 세부 휠 마커는 색역이 아니라 현재 선택된 색역 안의
 * 밝기별 톤이므로, 색역은 현재 선택값을 쓰고 기준색만 그 톤 색으로 잡는다.
 */
function handleDetailDrag(index, targetHue, targetSat) {
  const rgb = detailTones[index];
  if (!rgb) return;
  applyMarkerDrag(currentRange(), rgb, targetHue, targetSat);
}

/** 세부 휠 마커 더블탭 → 현재 색역 리셋. */
function handleDetailReset() {
  resetRange(currentRange());
}

/** 기준색 rgb를 targetHue/targetSat 방향으로 미는 CMY 델타를 range에 적용한다. */
function applyMarkerDrag(range, rgb, targetHue, targetSat) {
  const src = colorwheel.rgbToHsv(rgb[0], rgb[1], rgb[2]);
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
  resetRange(CHROMA_ORDER[index]);
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

/**
 * 벡터스코프 — 밀도 격자.
 *
 * 격자는 `preview.js`가 자기 픽셀 루프에서 이미 채워 뒀다(추가 순회 없음).
 * 여기서는 그리기만 한다.
 *
 * ── 왜 격자이고, 왜 매번 다시 그리는가 ──────────────────────────────────
 *
 * UXP는 canvas가 드래그 중 검게 클리어되고 SVG·rotate도 못 써 **DOM + translate만**
 * 가능하다. 픽셀마다 점을 찍는 것은 불가능하므로 평면을 격자로 나눠 도수를 센다.
 *
 * 처음에는 칸 820개를 미리 만들어 두고 **불투명도만 갱신**했다(팔레트가 쓰는 패턴).
 * 그런데 갱신 후에도 이전 칸이 남는다는 보고가 반복됐다. 클리어 로직 자체는 정상임을
 * 실제 데이터로 확인했다(707칸 → 4칸). 남는 설명은 **UXP가 820개의 개별 스타일 쓰기를
 * 다 반영하지 못한다**는 것이다 — 이 저장소에는 팔레트 div 15개만으로도 렌더 파이프가
 * 밀린 기록이 있다.
 *
 * 그래서 **필요한 칸만 매번 새로 그린다.** 한 번의 innerHTML 교체라 부분 반영이
 * 원천적으로 불가능하고, 이전 칸은 DOM에서 사라지므로 **남을 수가 없다.**
 * 그릴 칸은 데이터가 있는 것뿐이라(보통 수~수백 개) 820개를 만지는 것보다 가볍다.
 */
const SCOPE_PAD = 10;
const SCOPE_MIN = 200;
const SCOPE_MAX = 460;

/**
 * 원반 크기. **패널 폭에 맞춘다.**
 *
 * 처음에는 컬러휠과 같은 240px 고정이었는데 작다는 지적이 있었다. 전용 패널이라
 * 사용자가 크게 늘릴 수 있으므로 그 폭을 쓴다. UXP가 폭을 0으로 주는 경우가 있어
 * 그때는 기본값으로 떨어진다.
 */
function scopeSize() {
  const panel = $("scopePanel");
  const w = panel && panel.clientWidth;
  if (!w || w < SCOPE_MIN) return colorwheel.SIZE;
  return Math.max(SCOPE_MIN, Math.min(SCOPE_MAX, w - 16));
}

let scopeSizeUsed = 0; // 눈금 캐시가 어느 크기로 만들어졌는지

function scopeGeom() {
  const size = scopeSize();
  const R = size / 2 - SCOPE_PAD;
  return { size, R, cx: size / 2, cy: size / 2 };
}

/** 눈금(동심원·색상 방향)은 크기가 그대로면 변하지 않으므로 문자열을 재사용한다. */
let scopeChromeHtml = null;

function buildScopeChrome() {
  const { size } = scopeGeom();
  if (scopeChromeHtml !== null && scopeSizeUsed === size) return scopeChromeHtml;
  scopeSizeUsed = size;
  const { R, cx, cy } = scopeGeom();
  const parts = [];
  for (const f of [0.5, 1]) {
    const r = R * f;
    parts.push(
      `<div class="sc-ring" style="left:${cx - r}px;top:${cy - r}px;width:${r * 2}px;height:${r * 2}px"></div>`
    );
  }
  for (const [label, hue] of [["R", 0], ["Y", 60], ["G", 120], ["C", 180], ["B", 240], ["M", 300]]) {
    const [ox, oy] = colorwheel.polarOffset(hue, 1, R + 2);
    parts.push(`<div class="sc-axis" style="left:${cx + ox - 3}px;top:${cy + oy - 6}px">${label}</div>`);
  }
  scopeChromeHtml = parts.join("");
  return scopeChromeHtml;
}

function renderScope() {
  const host = $("scope");
  if (!host) return;

  // 패널 크기가 바뀌었을 수 있으므로 원반 지름을 매번 맞춘다.
  const geom = scopeGeom();
  host.style.width = geom.size + "px";
  host.style.height = geom.size + "px";

  const data = preview.scope();
  const cells = data && data.cells ? data.cells : [];
  const note = $("scopeNote");

  // 데이터가 없으면 눈금만 남긴다 — 이전 분포가 남지 않는다.
  if (!cells.length) {
    host.innerHTML = buildScopeChrome();
    if (note) note.textContent = "문서를 열면 분포가 표시됩니다";
    return;
  }

  const n = preview.GRID_N;
  const { R, cx, cy } = geom;
  const side = Math.ceil((R * 2) / n) + 1; // 칸 사이가 벌어지지 않게 살짝 크게
  const parts = [buildScopeChrome()];

  for (const c of cells) {
    // 격자 좌표(0~1) → [-1,1] 평면
    const nx = c.x * 2 - 1;
    const ny = c.y * 2 - 1;
    if (nx * nx + ny * ny > 1.02) continue; // 원 밖은 그리지 않는다

    const hue = (Math.atan2(-ny, nx) * 180) / Math.PI;
    const sat = Math.min(1, Math.hypot(nx, ny));
    const rgb = colorwheel.hsvToRgb(hue, sat, 1); // 0~255를 돌려준다
    const col =
      "rgb(" + Math.round(rgb[0]) + "," + Math.round(rgb[1]) + "," + Math.round(rgb[2]) + ")";
    // 하한을 두지 않는다. 하한이 있으면 한 픽셀짜리 칸도 무조건 보여 원이 채워진다.
    parts.push(
      `<div class="sc-cell" style="left:${(cx + nx * R - side / 2).toFixed(1)}px;` +
        `top:${(cy + ny * R - side / 2).toFixed(1)}px;width:${side}px;height:${side}px;` +
        `background:${col};opacity:${c.d.toFixed(3)}"></div>`
    );
  }

  // **한 번의 교체.** 부분 반영이 불가능하므로 이전 칸이 남을 수 없다.
  host.innerHTML = parts.join("");

  if (note) {
    note.textContent =
      "적용 결과 기준 · 무채색 제외 · 밀도는 상위 분위 기준 (계측기가 아니라 분포 모양을 보는 용도)";
  }
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

const PALETTE_LUT_SIZE = 33;

/**
 * 시각화용 LUT 두 벌.
 *   film — 색 조정 **전**. 컬러휠의 기준색을 만든다 (휠은 그 위에서 이동을 그린다)
 *   full — 색 조정까지. 팔레트의 최종색을 만든다 (적용 결과와 같다)
 *
 * **둘 다 `buildForParams`로 만든다.** 이전에는 여기서 `buildLut` + `bakeGrading`을
 * 직접 조합했는데, 그 바람에 **스캐너 단계가 빠져** 팔레트·컬러휠이 실제 적용
 * 결과와 다른 색을 보여줬다. 합성 순서를 아는 곳은 엔진 하나여야 한다.
 *
 * 팔레트·큰휠·세부휠이 한 프레임에 함께 갱신되므로 매번 새로 구우면 낭비다.
 * 파라미터가 그대로면 재사용한다.
 */
let lutCache = { key: null, film: null, full: null };

function visualTables() {
  const f = params.film || {};

  // ⚠️ 캐시 키에는 결과를 바꾸는 것이 **전부** 들어가야 한다. 이전 키에는
  // 스캐너와 enabled가 빠져 있어서, 스캐너를 바꿔도 팔레트가 갱신되지 않았다.
  const key = JSON.stringify([f.enabled, f.id, f.exposure, f.scanner, params.grading]);
  if (lutCache.key === key) return lutCache;

  try {
    // 기준색 — 같은 파라미터에서 색 조정만 끈 상태. 필름과 스캐너는 그대로다.
    const noGrading = { ...params, grading: { ...params.grading, enabled: false } };
    const base = film.buildForParams(noGrading, PALETTE_LUT_SIZE);
    const full = film.gradingIsActive(params.grading)
      ? film.buildForParams(params, PALETTE_LUT_SIZE)
      : base;
    lutCache = { key, film: base, full };
  } catch (e) {
    console.error("시각화 LUT 생성 실패", e);
    lutCache = { key, film: null, full: null };
  }
  return lutCache;
}

/**
 * sRGB 색 하나를 LUT에 통과시킨다.
 *
 * 팔레트·컬러휠 색은 sRGB로 정의돼 있는데 LUT은 ProPhoto 기준으로 구워진다.
 * 그래서 sRGB → ProPhoto → LUT → sRGB로 왕복해야 격자의 올바른 위치를 조회한다.
 * 그냥 넣으면 엉뚱한 색이 나온다.
 */
function throughLut(rgb, table) {
  if (!table) return rgb;
  const work = [0, 0, 0];
  const shown = [0, 0, 0];
  colorspace.srgbToProPhoto(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, work);
  lut.sample(table, PALETTE_LUT_SIZE, work[0], work[1], work[2], work);
  colorspace.proPhotoToSrgb(work[0], work[1], work[2], shown);
  return [shown[0] * 255, shown[1] * 255, shown[2] * 255];
}

/** 팔레트 스와치 한 칸의 최종색. */
function paletteResult(rgb, table) {
  if (!table) return simulate.applyGrading(rgb, params.grading);
  return throughLut(rgb, table);
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

  const table = visualTables().full;

  for (let i = 0; i < PALETTE.length; i++) {
    const rgb = PALETTE[i];
    const graded = paletteResult(rgb, table);
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
    // 격자 갱신은 preview.onScopeUpdate 구독으로 받는다 — promise로는 코얼레싱된
    // 렌더의 갱신 시점을 놓친다(preview.js의 onScopeUpdate 주석 참조).
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
  for (const id of ["btnApply", "btnSavePreset", "btnDeletePreset"]) {
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
/**
 * 필름 선택 칩을 만든다. sp-picker는 UXP에서 value를 읽고 쓸 수 없어
 * (코드로 선택 항목을 바꿀 수 없다) 커스텀 칩으로 대체한다.
 */
function buildFilmChips() {
  const host = $("filmChips");
  if (!host) return;
  host.textContent = "";
  for (const f of films.all()) {
    const chip = document.createElement("div");
    chip.className = "chip-btn";
    chip.textContent = f.displayName;
    chip.dataset.filmId = f.id;
    chip.addEventListener("click", () => {
      params.film.id = f.id;
      syncFilmUI();
      onParamsChanged();
    });
    host.appendChild(chip);
  }
}

/** 스캐너 선택 칩. 필름 칩과 같은 이유로 커스텀 칩을 쓴다. */
function buildScannerChips() {
  const host = $("scannerChips");
  if (!host) return;
  host.textContent = "";
  for (const s of scanner.all()) {
    const chip = document.createElement("div");
    chip.className = "chip-btn";
    chip.textContent = s.displayName;
    chip.dataset.scannerId = s.id;
    chip.addEventListener("click", () => {
      params.film.scanner = s.id;
      syncFilmUI();
      onParamsChanged();
    });
    host.appendChild(chip);
  }
}

function syncFilmUI() {
  const host = $("filmChips");
  if (host) {
    for (const chip of host.querySelectorAll(".chip-btn")) {
      chip.classList.toggle("active", chip.dataset.filmId === params.film.id);
    }
  }
  const shost = $("scannerChips");
  if (shost) {
    for (const chip of shost.querySelectorAll(".chip-btn")) {
      chip.classList.toggle("active", chip.dataset.scannerId === params.film.scanner);
    }
  }
  const note = $("filmNote");
  if (note && !params.film.enabled) {
    // 필름을 끈 상태는 "기능 없음"이 아니라 **마감 모드**다. 색이 이미 정해진
    // 파일(프로파일로 현상한 JPEG 등)에 할레이션·그레인만 얹는 경로이고,
    // 도구 이분화의 v1 쪽이다(v2plan 1.5). 그렇게 읽히지 않으면 사용자가
    // 8bit 문서에서 필름을 켜 놓고 밴딩을 보게 된다.
    note.textContent =
      "마감 모드 — 색은 그대로 두고 할레이션·그레인·색 조정만 얹습니다. " +
      "이미 현상된 JPEG 후처리에 맞습니다.";
    return;
  }
  if (note) {
    let def = null;
    try {
      def = films.byId(params.film.id);
    } catch (e) {
      /* 알 수 없는 id — 안내문만 비운다 */
    }
    const sc = scanner.byId(params.film.scanner);
    const parts = [];
    if (def && def.source && def.source.note) parts.push(def.source.note);
    if (sc && sc.id !== "none" && sc.note) parts.push(sc.note);
    note.textContent = parts.join("  /  ");
  }
}



/**
 * .cube 내보내기 설정.
 *
 * params에 넣지 않는다 — 프리셋은 "룩"을 담는 것이고 격자 크기나 대상 색공간은
 * 룩이 아니라 출력 형식이다. 프리셋에 섞으면 남의 프리셋을 불러올 때마다 내보내기
 * 설정이 같이 바뀐다.
 */
const cubeOpts = { size: cubeexport.SIZES[0], space: cubeexport.SPACES[0].id };

/** 격자·색공간 선택 칩. 필름 칩과 같은 이유로 sp-picker를 쓰지 않는다. */
function buildCubeChips() {
  const sizeHost = $("cubeSizeChips");
  if (sizeHost) {
    sizeHost.textContent = "";
    for (const n of cubeexport.SIZES) {
      const chip = document.createElement("div");
      chip.className = "chip-btn";
      chip.textContent = `${n}³`;
      chip.dataset.cubeSize = String(n);
      chip.addEventListener("click", () => {
        cubeOpts.size = n;
        syncCubeUI();
      });
      sizeHost.appendChild(chip);
    }
  }

  const spaceHost = $("cubeSpaceChips");
  if (spaceHost) {
    spaceHost.textContent = "";
    for (const s of cubeexport.SPACES) {
      const chip = document.createElement("div");
      chip.className = "chip-btn";
      chip.textContent = s.displayName;
      chip.dataset.cubeSpace = s.id;
      chip.addEventListener("click", () => {
        cubeOpts.space = s.id;
        syncCubeUI();
      });
      spaceHost.appendChild(chip);
    }
  }
}

function syncCubeUI() {
  const sizeHost = $("cubeSizeChips");
  if (sizeHost) {
    for (const chip of sizeHost.querySelectorAll(".chip-btn")) {
      chip.classList.toggle("active", Number(chip.dataset.cubeSize) === cubeOpts.size);
    }
  }
  const spaceHost = $("cubeSpaceChips");
  if (spaceHost) {
    for (const chip of spaceHost.querySelectorAll(".chip-btn")) {
      chip.classList.toggle("active", chip.dataset.cubeSpace === cubeOpts.space);
    }
  }
  const note = $("cubeNote");
  if (note) {
    // 설명과 함께 실제 파일명을 보여준다. 여러 벌 뽑을 때 어느 조합인지 헷갈린다.
    let name = "";
    try {
      name = cubeexport.suggestName(params, cubeOpts);
    } catch (e) {
      name = "";
    }
    note.textContent = `${cubeexport.spaceById(cubeOpts.space).note}${name ? `  /  ${name}` : ""}`;
  }

  const xn = $("xmpNote");
  if (xn) {
    // 프로파일은 격자가 32로 고정이고(ACR이 그 이상을 받지 않는다) 색공간도
    // ProPhoto로 고정이다. 고를 것이 없으므로 현재 대상만 알려준다.
    let n = "";
    try {
      n = xmpexport.profileName(params);
    } catch (e) {
      n = "";
    }
    const count = xmpexport.defaultSet(params).length;
    xn.textContent =
      `${xmpexport.LUT_SIZE}³ ProPhoto · Profile Browser의 "${xmpexport.GROUP}" 그룹` +
      `${n ? `  /  현재: ${n}` : ""}  /  세트 ${count}개`;
  }
}

function syncUI() {
  $("presetName").value = params.name === "Untitled" ? "" : params.name;

  $("filmEnabled").checked = params.film.enabled;
  setSlider("filmExposure", params.film.exposure);
  syncFilmUI();

  $("gradingEnabled").checked = params.grading.enabled;
  setSlider("toe", params.grading.toe);
  setSlider("shoulder", params.grading.shoulder);
  syncSelectiveColorSliders();


  const ct = params.grading.crosstalk;
  $("crosstalkEnabled").checked = ct.enabled;
  // 저장된 매트릭스에서 대표 강도를 역산해 슬라이더에 표시한다.
  ct.amount = crosstalkAmountFromMatrix(ct.matrix);
  setSlider("crosstalkAmount", ct.amount);


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
  syncSkinUI(); // 피부 색역일 때만 대역 설정을 보여준다
  renderDetail(); // 세부 휠을 새 색역으로 갱신
}

/**
 * 피부 색역 설정의 표시·값 갱신.
 *
 * 피부는 고정 6색역과 달리 **대역 자체를 조절**할 수 있어(색상각·폭) 전용 UI가
 * 붙는다. 다른 색역을 보고 있을 때는 감춘다 — 항상 띄우면 어느 색역에 딸린
 * 설정인지 헷갈린다.
 */
function syncSkinUI() {
  const box = $("skinOpts");
  if (!box) return;
  const on = currentRangeVal === "skin";
  box.style.display = on ? "block" : "none";
  if (!on) return;
  setSlider("skinRange", params.grading.skinRange);
  const cb = $("protectSkin");
  if (cb) cb.checked = !!params.grading.protectSkin;
  const note = $("skinNote");
  if (note) {
    note.textContent =
      `대역 중심 ${Number(params.grading.skinHue).toFixed(1)}° · ` +
      "폭을 넓히면 어두운 피부까지 잡히지만 나무·낙엽처럼 실제로 피부색인 물체도 딸려온다.";
  }
}

function updateRangeChips() {
  const chips = document.querySelectorAll("#scRange .chip-btn");
  for (const c of chips) {
    // classList가 UXP에서 불안정할 수 있어 className을 직접 세팅한다.
    c.className = c.dataset.range === currentRangeVal ? "chip-btn active" : "chip-btn";
  }
}

/**
 * 전경색을 피부 대역 중심으로 삼는다.
 *
 * 사용자가 Photoshop 스포이드로 피부를 찍고 이 버튼을 누른다. **패널에서 캔버스를
 * 직접 클릭할 수는 없다**(UXP 제약) — 전경색을 경유하는 쪽이 좌표 환산 문제가
 * 아예 없다(host/ps.js의 foregroundRgb 주석 참조).
 *
 * 색상각만 가져오고 채도·밝기는 쓰지 않는다. 한 점의 채도는 조명·노출에 따라 크게
 * 흔들리는데 대역 폭은 슬라이더가 담당하기 때문이다.
 */
function onPickSkin() {
  const rgb = ps.foregroundRgb();
  if (!rgb) return setStatus("전경색을 읽지 못했습니다.", true);
  const hsv = gamut.rgbToHsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  if (hsv.s < 0.05) {
    return setStatus("전경색이 무채색이라 피부 색상각을 정할 수 없습니다.", true);
  }
  params.grading.skinHue = Math.round(hsv.h * 10) / 10;
  syncSkinUI();
  onParamsChanged();
  setStatus(`피부 대역 중심을 ${params.grading.skinHue.toFixed(1)}°로 맞췄습니다.`);
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
    // 막지 않고 알리기만 한다. 무엇을 경고할지는 모드에 따라 다르다 —
    // 마감 모드(필름 끔)의 8bit는 정상 입력이므로 경고하지 않는다.
    let warning = "";
    try {
      const warnings = apply.validate(ps.activeDocument(), params);
      if (warnings.length) warning = " (" + warnings.join(" ") + ")";
    } catch (e) {
      // 문서 없음 등은 아래 파이프라인이 제대로 보고하므로 여기서 막지 않는다.
      // 다만 **조용히 삼키지는 않는다** — 검사가 터져서 경고가 사라진 것과
      // 경고할 것이 없던 것은 화면에서 구분되지 않는다. 실제로 그 차이를 못 가려
      // 한 번 헤맸다.
      console.error("경고 검사 실패", e);
    }
    await pipeline.applyToActiveDocument(params);
    setStatus("적용 완료" + warning);
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

  // 분포 격자는 **데이터가 실제로 바뀔 때** 다시 그린다. promise로 잡으면 코얼레싱된
  // 렌더의 갱신을 놓쳐 화면이 과거 프레임에 멈춘다(preview.js onScopeUpdate 주석).
  preview.onScopeUpdate(renderScope);

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

  // 피부 색역 전용 설정
  bindSlider("skinRange", "grading.skinRange");
  bindCheckbox("protectSkin", "grading.protectSkin");
  const pick = $("btnPickSkin");
  if (pick) pick.addEventListener("click", onPickSkin);

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

  $("btnExportCube").addEventListener("click", async () => {
    const btn = $("btnExportCube");
    btn.disabled = true;
    try {
      setStatus("LUT 굽는 중...");
      const name = await exportfile.exportCube(params, cubeOpts);
      setStatus(name ? `${name} 내보냄` : "취소됨");
    } catch (e) {
      setStatus(e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  });

  $("btnExportXmp").addEventListener("click", async () => {
    const btn = $("btnExportXmp");
    btn.disabled = true;
    try {
      setStatus("프로파일 만드는 중...");
      const name = await exportfile.exportXmpOne(params, { space: "prophoto" });
      setStatus(name ? `${name} 내보냄` : "취소됨");
    } catch (e) {
      setStatus(e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  });

  $("btnExportXmpSet").addEventListener("click", async () => {
    const btn = $("btnExportXmpSet");
    btn.disabled = true;
    try {
      const list = xmpexport.defaultSet(params);
      setStatus(`${list.length}개 프로파일 — 저장할 폴더를 고르세요`);
      const r = await exportfile.exportXmpSet(list, { space: "prophoto" }, (done, total) => {
        if (done < total) setStatus(`프로파일 ${done + 1}/${total} 생성 중...`);
      });
      if (!r) return setStatus("취소됨");
      if (r.failed.length) {
        // 실패 건수만 보여주면 원인을 알 수 없다. 첫 에러 메시지를 그대로 낸다.
        console.error("프로파일 내보내기 실패", r.failed);
        setStatus(`실패 (${r.failed[0].name}): ${r.failed[0].error}`, true);
      } else {
        setStatus(`${r.written.length}개 내보냄 — ${r.folder}`);
      }
    } catch (e) {
      setStatus(e.message || String(e), true);
    } finally {
      btn.disabled = false;
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

  bindCheckbox("filmEnabled", "film.enabled");
  bindSlider("filmExposure", "film.exposure");

  $("btnApply").addEventListener("click", onApply);

}

async function init() {
  wire();
  buildFilmChips(); // syncUI가 칩 상태를 갱신하므로 먼저 만들어 둔다
  buildScannerChips();
  buildCubeChips();
  syncUI();
  syncCubeUI();
  wheelCtrl = colorwheel.build($("wheel"), {
    onMarkerDrag: handleMarkerDrag,
    onMarkerReset: handleMarkerReset,
  });
  detailCtrl = colorwheel.build($("wheelDetail"), {
    onMarkerDrag: handleDetailDrag,
    onMarkerReset: handleDetailReset,
    spreadTones: true, // 밝기별 톤을 반경으로 벌려 겹침 방지
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
  renderDetail();
  renderPalette();
  try {
    await presets.seedIfEmpty();
    await refreshPresetList();
  } catch (e) {
    setStatus(`프리셋 초기화 실패: ${e.message || e}`, true);
  }
  // 컬러휠 대표색 + 초기 미리보기. 분석과 미리보기가 각각 executeAsModal을 잡으므로
  // 동시에 띄우지 않고 이 한 경로에서 순서대로 처리한다.
  await refreshForActiveDoc(true);

  // 문서 전환 시 재갱신. select 등이 자주 오지만 refreshForActiveDoc이 문서 id로
  // 걸러 실제 전환일 때만 처리한다. 이벤트 미지원 시 조용히 무시.
  try {
    const { action } = require("photoshop");
    action.addNotificationListener(
      [{ event: "select" }, { event: "open" }, { event: "newDocument" }, { event: "close" }],
      () => { scheduleDocCheck(); }
    );
  } catch (e) {
    console.error("문서 전환 리스너 등록 실패", e);
  }
}

init();


