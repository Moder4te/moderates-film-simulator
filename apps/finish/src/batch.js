/**
 * 배치 적용.
 *
 * 폴더 안의 이미지를 하나씩 열고 파이프라인을 적용한 뒤 지정 폴더로 내보낸다.
 * 안전 규칙:
 *   - **원본 파일을 덮어쓰지 않는다.** 폴더 비교는 1차 방어일 뿐이고(별칭·대소문자에
 *     뚫린다) 실제 보증은 저장 직전의 파일 단위 검사(`isSameFile`)가 만든다.
 *   - 한 장이 실패해도 전체를 중단하지 않고 로그에 남기고 계속한다.
 *   - 문서를 순차적으로 열고 닫아 메모리 누적을 막는다.
 */

const { app, core } = require("photoshop");
const { storage } = require("uxp");
const fs = storage.localFileSystem;
const pipeline = require("./pipeline");
const { samePath } = require("../lib/shared/paths");

const IMAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd", ".dng", ".cr2", ".cr3",
  ".nef", ".arw", ".raf", ".rw2", ".orf",
];

function isImage(entry) {
  const name = entry.name.toLowerCase();
  return entry.isFile && IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function outputName(sourceName, options) {
  const base = stripExtension(sourceName);
  const prefix = options.prefix || "";
  const suffix = options.suffix || "";
  const ext = options.format === "png" ? "png" : options.format === "psd" ? "psd" : "jpg";
  return `${prefix}${base}${suffix}.${ext}`;
}

async function collectFiles(folder, recursive) {
  const entries = await folder.getEntries();
  const files = [];

  for (const entry of entries) {
    if (isImage(entry)) {
      files.push(entry);
    } else if (recursive && entry.isFolder) {
      files.push(...(await collectFiles(entry, true)));
    }
  }

  return files;
}

/**
 * 출력 파일이 원본 그 파일인가.
 *
 * 폴더 경로 비교(`runBatch`)는 1차 방어일 뿐이다. 뚫리면 **원본이 그 자리에서
 * 지워진다** — `prefix`는 UI에서 아예 전달되지 않고 `format` 기본값이 `"jpg"`라,
 * 사용자가 접미사 칸(기본 `_film`)을 **비우기만 하면** jpg 원본의 출력 파일명이
 * 원본과 완전히 같아진다. 지우는 데 클릭 몇 번이면 되고, 되돌릴 방법은 없다.
 * `README.md`가 약속한 "원본은 어떤 경우에도 수정되지 않는다"의 실제 방어선은 여기다.
 *
 * 두 단계로 본다.
 *
 *   1. 경로   `shared/paths.js`의 정규화 비교. 대소문자·후행 구분자를 흡수한다.
 *   2. 크기+수정시각   경로가 달라도 **같은 파일**일 수 있다(심볼릭 링크·별칭·
 *      매핑 드라이브). 이 경우 `getEntry`가 돌려준 것이 원본 그 자체이므로 크기와
 *      수정 시각이 정확히 일치한다.
 *
 * 2단계는 원리상 오탐이 가능하다 — 사용자가 원본을 **타임스탬프까지 보존해** 출력
 * 폴더에 복사해 둔 경우다. 그때는 저장을 거부하고 사유를 알린다. 되돌릴 수 없는
 * 원본 손실과 "접미사를 붙이세요" 안내 사이에서는 후자가 맞다.
 *
 * 이전 실행의 산출물은 걸리지 않는다. 처리된 결과라 크기가 다르고 나중에 쓰였다 —
 * **같은 출력 폴더로 다시 돌리는 것은 정상 사용**이므로 이게 걸리면 안 된다.
 */
async function isSameFile(outFolder, name, sourceEntry) {
  let existing;
  try {
    existing = await outFolder.getEntry(name);
  } catch (e) {
    return false; // 대상이 없으면 충돌 자체가 없다
  }
  if (!existing) return false;
  if (samePath(existing.nativePath, sourceEntry.nativePath)) return true;

  try {
    const [a, b] = await Promise.all([existing.getMetadata(), sourceEntry.getMetadata()]);
    const at = a.dateModified && a.dateModified.getTime();
    const bt = b.dateModified && b.dateModified.getTime();
    return a.size === b.size && at != null && at === bt;
  } catch (e) {
    // 메타데이터를 못 읽으면 판정을 포기한다. 1단계는 이미 통과했으므로 진행한다.
    return false;
  }
}

async function saveDocument(doc, outFolder, name, options, sourceEntry) {
  if (await isSameFile(outFolder, name, sourceEntry)) {
    throw new Error(
      `출력 파일이 원본과 같습니다: ${name} (접두사·접미사를 주거나 다른 폴더를 고르세요)`
    );
  }

  // overwrite는 **true로 둔다.** 같은 출력 폴더에 설정만 바꿔 다시 돌리는 것은 정상
  // 사용인데, false로 두면 그게 전부 "이미 존재함"으로 실패한다. 막아야 하는 것은
  // 덮어쓰기 일반이 아니라 원본 그 파일을 덮어쓰는 것 하나이고, 그건 위에서 막았다.
  const target = await outFolder.createFile(name, { overwrite: true });

  if (options.format === "png") {
    await doc.saveAs.png(target, { compression: 6 }, true);
  } else if (options.format === "psd") {
    await doc.saveAs.psd(target, {}, true);
  } else {
    await doc.saveAs.jpg(target, { quality: options.quality ?? 10 }, true);
  }
}

/**
 * @param {object} params    적용할 필름 파라미터
 * @param {object} options   { recursive, format, quality, prefix, suffix }
 * @param {function} onProgress  (done, total, currentName) => void
 * @returns {{ total:number, succeeded:number, failed:Array<{file:string,error:string}> }}
 */
async function runBatch(params, options, onProgress) {
  const sourceFolder = await fs.getFolder();
  if (!sourceFolder) return null;

  const outputFolder = await fs.getFolder();
  if (!outputFolder) return null;

  // 1차 방어. 실행 자체를 막아 사용자에게 곧바로 알린다. 다만 이것만으로는 보증이
  // 성립하지 않는다 — 별칭·매핑 드라이브는 경로가 아예 다르다. 진짜 방어선은
  // saveDocument의 isSameFile이다.
  if (samePath(outputFolder.nativePath, sourceFolder.nativePath)) {
    throw new Error("출력 폴더가 원본 폴더와 같습니다. 다른 폴더를 선택하세요.");
  }

  const files = await collectFiles(sourceFolder, options.recursive);
  const failed = [];
  let succeeded = 0;

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (onProgress) onProgress(i, files.length, entry.name);

    let doc = null;
    try {
      await core.executeAsModal(
        async () => {
          doc = await app.open(entry);
          await pipeline.run(doc, params);
          await saveDocument(doc, outputFolder, outputName(entry.name, options), options, entry);
        },
        { commandName: `Film Sim: ${entry.name}` }
      );
      succeeded++;
    } catch (e) {
      failed.push({ file: entry.name, error: e.message || String(e) });
    } finally {
      // 성공/실패와 무관하게 문서를 닫아 메모리를 회수한다.
      if (doc) {
        try {
          await core.executeAsModal(async () => doc.closeWithoutSaving(), {
            commandName: "Close",
          });
        } catch (e) {
          console.error("문서 닫기 실패", e);
        }
      }
    }
  }

  if (onProgress) onProgress(files.length, files.length, null);

  return { total: files.length, succeeded, failed };
}

module.exports = { runBatch };
