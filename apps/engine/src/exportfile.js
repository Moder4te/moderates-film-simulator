/**
 * 내보내기 파일 I/O — `.cube`와 Lightroom/ACR 프로파일(`.xmp`)을 디스크에 쓴다.
 *
 * **직렬화는 `core/io`가, 파일 쓰기는 여기가 한다.** core는 순수해야 하므로
 * `uxp` 저장소 API를 부를 수 없다(경계 검사 규칙 1). 그래서 텍스트·바이너리를
 * 만드는 일과 저장하는 일을 갈라 두었고, 이 파일이 그 사이를 잇는다.
 *
 * ⚠️ 이 모듈이 없어서 `.cube`·프로파일 내보내기가 **런타임에 죽고 있었다**
 * (`cubeexport.exportToFile is not a function`). main.js가 `core/io/cube`에
 * 직접 파일 함수를 기대했는데 거기엔 직렬화만 있다. 정적 검사는 모듈 로드만
 * 확인하고 함수 호출까지는 보지 않아 통과했다.
 */

const { storage } = require("uxp");
const fs = storage.localFileSystem;
const cube = require("../lib/core/io/cube");
const xmp = require("../lib/core/io/xmp");

/** 파일명으로 쓸 수 없는 문자를 제거한다. presets.js와 같은 규칙. */
function slugify(name) {
  return (
    String(name)
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 80) || "untitled"
  );
}

/**
 * 현재 설정을 `.cube`로 내보낸다. 사용자가 위치를 고른다.
 * @returns {Promise<string|null>} 저장한 파일 이름. 사용자가 취소하면 null
 */
async function exportCube(params, opts) {
  const text = cube.build(params, opts); // 내보낼 것이 없으면 여기서 던진다
  const suggested = slugify(cube.suggestName(params, opts));
  const file = await fs.getFileForSaving(suggested, { types: ["cube"] });
  if (!file) return null;
  await file.write(text);
  return file.name;
}

/**
 * 현재 설정을 프로파일 하나(`.xmp`)로 내보낸다.
 * @returns {Promise<string|null>} 저장한 파일 이름. 취소하면 null
 */
async function exportXmpOne(params, opts) {
  const text = xmp.buildXmp(params, opts);
  const suggested = xmp.fileNameFor(params, opts);
  const file = await fs.getFileForSaving(suggested, { types: ["xmp"] });
  if (!file) return null;
  await file.write(text);
  return file.name;
}

/**
 * 프로파일 세트를 폴더에 한꺼번에 쓴다.
 *
 * **한 장이 실패해도 멈추지 않는다.** 배치 적용과 같은 방침이다 — 하나 때문에
 * 나머지를 잃는 것이 사용자에게 더 나쁘다. 실패 목록을 함께 돌려준다.
 *
 * 실패 항목은 **이름과 사유를 함께** 담는다. 건수만 주면 원인을 알 수 없다.
 *
 * @param {Array<object>} list      defaultSet 등이 만든 파라미터 배열
 * @param {object} opts             { space }
 * @param {function} [onProgress]   (완료수, 전체수) => void
 * @returns {Promise<{folder:string, written:Array<string>, failed:Array<{name:string,error:string}>}|null>}
 */
async function exportXmpSet(list, opts, onProgress) {
  const folder = await fs.getFolder();
  if (!folder) return null;

  const written = [];
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const name = xmp.profileName(p, opts);
    try {
      const text = xmp.buildXmp(p, opts);
      const file = await folder.createFile(xmp.fileNameFor(p, opts), { overwrite: true });
      await file.write(text);
      written.push(file.name);
    } catch (e) {
      failed.push({ name, error: e.message || String(e) });
      console.error("프로파일 내보내기 실패: " + name, e);
    }
    if (onProgress) onProgress(i + 1, list.length);
  }
  return { folder: folder.name, written, failed };
}

module.exports = { exportCube, exportXmpOne, exportXmpSet };
