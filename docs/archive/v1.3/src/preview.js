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
const simulate = require("./simulate");

const PV_WIDTH = 300; // 썸네일 긴 축(가로) px
let busy = false;
let pendingParams = null;

function imgEl() {
  return document.getElementById("pvImage");
}

/**
 * 소스 버퍼에 grading을 적용해 RGB 3채널 버퍼로 만든다.
 *
 * 채널 수는 문서마다 다르다 — 투명도/레이어가 있으면 4(RGBA), 플랫 JPEG 같은
 * 불투명 문서는 3(RGB). 스트라이드를 4로 고정하면 3채널 문서에서 채널이 밀려
 * 색이 깨지고 출력 하위 1/4이 검게 남는다. imageData.components를 그대로 쓴다.
 */
function gradePixels(data, comps, pixelCount, grading) {
  // 출력은 항상 w*h*3 이어야 한다(createImageDataFromBuffer가 크기를 검사한다).
  // 소스가 짧으면 읽기만 줄이고 남는 픽셀은 0으로 둔다.
  const rgb = new Uint8Array(pixelCount * 3);
  const count = Math.min(pixelCount, Math.floor(data.length / comps));
  // 그레이스케일(comps 1) 같은 경우 단일 채널을 3채널로 복제한다.
  const gOff = comps > 1 ? 1 : 0;
  const bOff = comps > 2 ? 2 : 0;
  for (let p = 0, i = 0, j = 0; p < count; p++, i += comps, j += 3) {
    const out = simulate.applyGrading([data[i], data[i + gOff], data[i + bOff]], grading);
    rgb[j] = out[0];
    rgb[j + 1] = out[1];
    rgb[j + 2] = out[2];
  }
  return rgb;
}

async function renderOnce(params) {
  const img = imgEl();
  if (!img) return;
  const empty = document.querySelector(".pv-empty");
  if (!app.documents.length) {
    img.style.display = "none";
    if (empty) empty.style.display = "block";
    return;
  }
  const docId = app.activeDocument.id;

  await core.executeAsModal(
    async () => {
      // colorSpace를 RGB로 고정해 그레이스케일·CMYK 문서에서도 RGB로 받는다.
      const px = await imaging.getPixels({
        documentID: docId,
        targetSize: { width: PV_WIDTH },
        colorSpace: "RGB",
      });
      const w = px.imageData.width;
      const h = px.imageData.height;
      const comps = px.imageData.components;
      const data = await px.imageData.getData({ chunky: true });

      const rgb = gradePixels(data, comps, w * h, params.grading);

      const rgbID = await imaging.createImageDataFromBuffer(rgb, {
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

      rgbID.dispose();
      px.imageData.dispose();
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
    pendingParams = params;
    return;
  }
  busy = true;
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

module.exports = { render };
