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

/** RGBA 버퍼에 grading을 적용해 RGB 3채널 버퍼로 만든다. */
function gradePixels(data, w, h, grading) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const out = simulate.applyGrading([data[i], data[i + 1], data[i + 2]], grading);
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
  const doc = app.activeDocument;

  await core.executeAsModal(
    async () => {
      const px = await imaging.getPixels({
        documentID: doc.id,
        targetSize: { width: PV_WIDTH },
      });
      const w = px.imageData.width;
      const h = px.imageData.height;
      const data = await px.imageData.getData({ chunky: true });

      const rgb = gradePixels(data, w, h, params.grading);

      const rgbID = await imaging.createImageDataFromBuffer(rgb, {
        width: w,
        height: h,
        components: 3,
        componentSize: 8,
        colorSpace: "RGB",
      });
      const enc = await imaging.encodeImageData({ imageData: rgbID, base64: true });

      img.src = "data:image/jpeg;base64," + enc;
      img.style.display = "block";
      if (empty) empty.style.display = "none";

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
