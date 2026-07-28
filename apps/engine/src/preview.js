/**
 * 패널 내 실시간 미리보기.
 *
 * 활성 문서를 축소해 읽고(getPixels), grading을 픽셀마다 적용한 뒤 base64 JPEG로
 * 인코딩해 패널의 <img>에 그린다. Photoshop에 별도 문서를 열지 않는다.
 *
 * 검증된 UXP imaging 파이프라인:
 *   getPixels(targetSize) → getData(RGBA) → RGB 3채널 추출(alpha 있으면 JPEG 인코딩
 *   불가) → createImageDataFromBuffer → encodeImageData(base64) → img data URI
 *
 * 성능(측정): 280px 썸네일에서 grading 픽셀순회 ~85ms + 나머지 ~5ms = ~90ms.
 * 조작 중이 아니라 조작이 멈춘 뒤(디바운스) 갱신한다. 조작 중 실시간 피드백은
 * 가벼운 팔레트·컬러휠 시뮬레이션이 담당한다.
 *
 * 범위: grading(색)만 반영한다. halation/grain은 공간 연산이라 픽셀 JS로는 무겁고
 * 근사가 부정확하므로 미리보기에서 제외한다. 실제 결과는 [적용]으로 확인한다.
 */

const { app, imaging, core } = require("photoshop");
const lut = require("../lib/core/color/lut");
const film = require("../lib/core/color/film");
const films = require("../lib/core/color/films");
const colorspace = require("../lib/core/color/colorspace");
const ps = require("../lib/host/ps");
const vectorscope = require("../lib/core/color/vectorscope");

const PV_WIDTH = 300; // 썸네일 긴 축(가로) px
/**
 * 벡터스코프 격자 한 변.
 *
 * 64로 잡았다가 낮췄다 — **야경 네온에서 셀이 2153개**까지 나왔다. UXP는 DOM을
 * native UI로 매핑하는 비용이 커서(팔레트 div 15개도 드래그 중 렌더 파이프를
 * 오버로드한 적이 있다) 그 규모는 위험하다. 32면 같은 장면이 652개고 240px 휠에서
 * 셀이 6.9px라 읽기에도 충분하다. 격자 크기가 곧 셀 수의 **상한**이라 병리적 입력에도
 * 1024개를 넘지 않는다.
 */
const GRID_N = 32;

/**
 * 마지막 렌더의 벡터스코프 격자. 픽셀 루프에서 함께 채워진다.
 * **적용 결과 기준**이다 — 조정이 색을 어디로 밀었는지 보는 것이 목적이라서.
 */
const EMPTY_SCOPE = { cells: [], total: 0, peak: 0 };
let lastScope = EMPTY_SCOPE;
let scopeListener = null;

/**
 * 격자가 갱신될 때 호출될 함수를 등록한다.
 *
 * ⚠️ **promise로는 갱신 시점을 못 잡는다.** `render()`는 이미 렌더 중이면 요청만
 * 남기고 **즉시 반환**하는데(코얼레싱), 그때 호출자의 `.then`은 **낡은 격자**로
 * 실행된다. 이어서 진행 중이던 렌더가 끝나고 밀린 요청까지 처리하며 격자를 다시
 * 채우지만, 그 시점에 다시 그리라고 알려 줄 방법이 없었다. 그래서 화면이 과거
 * 프레임에 멈춰 **이전 색이 사라지지 않는 것처럼 보였다.**
 *
 * 데이터가 실제로 바뀌는 자리에서 직접 알린다.
 */
function onScopeUpdate(fn) {
  scopeListener = fn;
}

function publishScope(next) {
  lastScope = next;
  if (scopeListener) {
    try {
      scopeListener(lastScope);
    } catch (e) {
      console.error("분포 갱신 실패", e);
    }
  }
}
let busy = false;
let busySince = 0;
let pendingParams = null;

/** 이 시간 넘게 잠겨 있으면 잠금이 새어 나간 것으로 보고 강제로 재시작한다. */
const STUCK_MS = 8000;

function imgEl() {
  return document.getElementById("pvImage");
}


function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 소스 버퍼에 색 단계를 적용해 8bit RGB 3채널 버퍼로 만든다.
 *
 * 채널 수는 문서마다 다르다 — 투명도/레이어가 있으면 4(RGBA), 플랫 JPEG 같은
 * 불투명 문서는 3(RGB). 스트라이드를 4로 고정하면 3채널 문서에서 채널이 밀려
 * 색이 깨지고 출력 하위 1/4이 검게 남는다. imageData.components를 그대로 쓴다.
 *
 * ⚠ **심도도 문서마다 다르다.** 16bit 문서에서 getPixels는 0~65535를 그대로 준다.
 * v1은 이걸 8bit로 가정해 전부 255로 클램프했고, 그래서 16bit 문서에서는 미리보기가
 * 하얗게 날아갔다. 평소 8bit JPEG로 작업하면 드러나지 않던 버그다. v2는 16bit가
 * 전제이므로 여기서 정규화한다. (`getPixels`에 `componentSize: 8`을 주는 방법은
 * 쓰면 안 된다 — 16bit 문서에서 -32005로 죽는다. docs/archive/v2plan.md 부록 B 참조)
 *
 * 출력이 항상 8bit인 이유는 encodeImageData가 JPEG를 만들기 때문이다.
 */
function renderPixels(data, comps, pixelCount, params, table, size, toDisplay) {
  // 출력은 항상 w*h*3 이어야 한다(createImageDataFromBuffer가 크기를 검사한다).
  // 소스가 짧으면 읽기만 줄이고 남는 픽셀은 0으로 둔다.
  const rgb = new Uint8Array(pixelCount * 3);
  const count = Math.min(pixelCount, Math.floor(data.length / comps));
  // 그레이스케일(comps 1) 같은 경우 단일 채널을 3채널로 복제한다.
  const gOff = comps > 1 ? 1 : 0;
  const bOff = comps > 2 ? 2 : 0;

  // 16bit 문서의 최대값은 32768이다(65535가 아니다). lut.js의 PS_MAX_16 참조.
  const maxV = lut.maxValueFor(data);


  // 색 단계는 문서 색공간에서 하고, 마지막에 표시용 sRGB로 옮긴다.
  // 순서가 중요하다 — LUT은 ProPhoto 기준으로 구워졌으므로 변환 전에 적용해야 한다.
  const disp = toDisplay || colorspace.passthrough;
  const shown = [0, 0, 0];

  // **경로가 하나다.** 이전에는 필름이 꺼지면 `simulate.applyGrading`을 직접
  // 부르는 별도 경로로 빠졌는데, 적용 쪽은 그때 아무것도 하지 않아서 미리보기와
  // 결과가 어긋났다(실측 최대 14/255). 지금은 필름이 꺼져도 `buildForParams`가
  // 항등에서 시작해 그레이딩만 구운 LUT을 주므로 여기서 나눌 이유가 없다.
  const inv = 1 / maxV;
  const out = [0, 0, 0];
  // 벡터스코프 격자를 **이 루프에 얹는다.** 이미 전 픽셀을 돌고 있으므로 추가 순회가
  // 없다 — 따로 돌면 파라미터를 만질 때마다 프록시를 한 번 더 훑게 된다.
  const grid = vectorscope.createGrid(GRID_N);
  for (let p = 0, i = 0, j = 0; p < count; p++, i += comps, j += 3) {
    lut.sample(table, size, data[i] * inv, data[i + gOff] * inv, data[i + bOff] * inv, out);
    disp(out[0], out[1], out[2], shown);
    rgb[j] = clamp255(shown[0] * 255);
    rgb[j + 1] = clamp255(shown[1] * 255);
    rgb[j + 2] = clamp255(shown[2] * 255);
    grid.add(shown[0], shown[1], shown[2]); // 적용 결과 기준
  }
  publishScope(grid.cells());
  return rgb;
}

/**
 * 문서의 색 프로파일 이름. 표시용 변환기를 고르는 데 쓴다.
 * 디스크립터는 host/ps.js가 소유한다 — batchPlay 호출을 한곳에 모아 둔다.
 */
async function documentProfile() {
  return ps.documentProfile();
}

async function renderOnce(params) {
  const img = imgEl();
  if (!img) return;
  const empty = document.querySelector(".pv-empty");
  if (!app.documents.length) {
    img.style.display = "none";
    if (empty) empty.style.display = "block";
    // 문서를 닫으면 분포도 비운다. 안 그러면 닫힌 문서의 격자가 그대로 남는다.
    publishScope(EMPTY_SCOPE);
    return;
  }
  const docId = app.activeDocument.id;

  // 필름 엔진이 켜져 있으면 LUT을 굽는다(색 조정까지 구워 넣은 최종본).
  // 33³ 생성이 1ms라 매 렌더마다 새로 구워도 부담이 없다 — 캐시가 필요 없는
  // 이유다(docs/archive/v2plan.md 4.1).
  // 필름이 꺼져 있어도 굽는다 — 그때는 항등 + 그레이딩이 나온다.
  // 실패하면 렌더를 건너뛴다. 옛 값으로 그리면 사용자가 잘못된 상태를 본다.
  let table = null;
  const size = 33;
  try {
    table = film.buildForParams(params, size);
  } catch (e) {
    console.error("LUT 생성 실패", e);
    return;
  }

  // 표시용 변환기. 문서가 ProPhoto면 sRGB로 옮겨야 어둡게 보이지 않는다.
  const toDisplay = colorspace.displayConverter(await documentProfile());

  await core.executeAsModal(
    async (ctx) => {
      // ── 격리: FilmSim 레이어를 숨겨 '깨끗한 원본'만 읽는다 ─────────────────
      //
      // getPixels는 합성본을 읽는다. 색을 [적용]하면 문서에 색 레이어가 구워지는데,
      // 그걸 그대로 읽어 LUT을 또 얹으면 미리보기가 **중복 적용된 상태로 보인다**
      // (실제 이미지는 멀쩡한데 미리보기만 두 번 먹은 것처럼). 미리보기는 "원본 →
      // LUT"을 보여야 하므로, 이미 얹힌 색·마감(FilmSim 전부)을 잠시 숨기고 읽는다.
      //
      // 히스토리 오염 방지를 위해 suspendHistory로 감싼다. 숨김→읽기→복원이 한
      // 모달 안에서 끝나 순 변화가 없으므로 캔버스 플리커도 없다.
      const doc = app.activeDocument;
      const hidden = [];
      const history = await ctx.hostControl.suspendHistory({
        documentID: docId,
        name: "미리보기",
      });
      let px;
      try {
        const foreign = ps.collectLayers(
          doc.layers,
          (l) => l.name && l.name.startsWith("FilmSim"),
          []
        );
        for (const l of foreign) {
          if (l.visible) { l.visible = false; hidden.push(l); }
        }
        // colorSpace를 RGB로 고정해 그레이스케일·CMYK 문서에서도 RGB로 받는다.
        px = await imaging.getPixels({
          documentID: docId,
          targetSize: { width: PV_WIDTH },
          colorSpace: "RGB",
        });
      } finally {
        for (const l of hidden) {
          try { l.visible = true; } catch (e) { /* 이미 지워진 참조 */ }
        }
        await ctx.hostControl.resumeHistory(history);
      }
      // ── imageData 수명 ─────────────────────────────────────────────────
      //
      // `imageData`는 네이티브 버퍼를 잡는다. `dispose()`를 못 부르면 그대로 샌다.
      // **여기는 슬라이더를 만질 때마다 도는 경로**라, 예외 한 번이 아니라 예외가
      // 나는 상태(색역 밖 파라미터 등)로 슬라이더를 끄는 동안 계속 쌓인다.
      //
      // `apply.js`·`grading.js`·`halation.js`·`grain.js`는 전부 try/finally로 지키는데
      // 여기만 직선 코드였다. `renderPixels`나 `createImageDataFromBuffer`가 던지면
      // 아래 dispose에 도달하지 못한다.
      let rgbID = null;
      try {
        const w = px.imageData.width;
        const h = px.imageData.height;
        const comps = px.imageData.components;
        const data = await px.imageData.getData({ chunky: true });

        const rgb = renderPixels(data, comps, w * h, params, table, size, toDisplay);

        rgbID = await imaging.createImageDataFromBuffer(rgb, {
          width: w,
          height: h,
          components: 3,
          componentSize: 8,
          colorSpace: "RGB",
        });
        const enc = await imaging.encodeImageData({ imageData: rgbID, base64: true });

        // 렌더 도중 문서가 바뀌었으면 낡은 프레임으로 덮어쓰지 않는다.
        // (덮어쓰면 새 문서 위에 이전 사진이 남는다)
        const stillCurrent = app.documents.length && app.activeDocument.id === docId;
        if (stillCurrent) {
          img.src = "data:image/jpeg;base64," + enc;
          img.style.display = "block";
          if (empty) empty.style.display = "none";
        }
      } finally {
        // dispose 자체가 던져도 나머지 하나는 반드시 푼다.
        if (rgbID) {
          try { rgbID.dispose(); } catch (e) { /* 이미 풀린 버퍼 */ }
        }
        try { px.imageData.dispose(); } catch (e) { /* 이미 풀린 버퍼 */ }
      }
    },
    { commandName: "미리보기 렌더" }
  );
}

/**
 * 미리보기 갱신 요청. 이미 렌더 중이면 최신 파라미터만 남겨 두고, 끝난 뒤
 * 한 번 더 렌더한다(coalescing). modal 중첩과 과도한 렌더를 막는다.
 */
async function render(params) {
  if (busy) {
    // ⚠️ `busy`가 풀리지 않으면 **미리보기가 영구히 멈춘다.** 실제로 그런 일이
    // 있었다 — batchPlay 조회 하나가 끝나지 않아 `renderOnce`가 반환하지 않았고,
    // 이후 요청이 전부 여기서 삼켜졌다. 사용자에게는 "미리보기가 호출되지 않는"
    // 것으로 보인다.
    //
    // 예외는 아래 finally가 풀어 주지만 **영영 끝나지 않는 경우는 못 푼다.**
    // 그래서 오래 잠겨 있으면 잠금을 무시하고 새로 시작한다.
    if (Date.now() - busySince < STUCK_MS) {
      pendingParams = params;
      return;
    }
    console.error("미리보기가 " + STUCK_MS + "ms 넘게 잠겨 있어 강제로 재시작합니다");
  }
  busy = true;
  busySince = Date.now();
  try {
    await renderOnce(params);
    // 렌더 중 들어온 최신 요청이 있으면 한 번 더.
    while (pendingParams) {
      const p = pendingParams;
      pendingParams = null;
      await renderOnce(p);
    }
  } catch (e) {
    console.error("미리보기 렌더 실패", e);
  } finally {
    busy = false;
  }
}

/** 마지막 렌더의 벡터스코프 격자. 렌더 전이면 빈 결과. */
function scope() {
  return lastScope;
}

module.exports = { render, scope, onScopeUpdate, GRID_N };
