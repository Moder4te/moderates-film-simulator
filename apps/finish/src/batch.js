/**
 * 배치 적용.
 *
 * 폴더 안의 이미지를 하나씩 열고 파이프라인을 적용한 뒤 지정 폴더로 내보낸다.
 * 안전 규칙:
 *   - 원본 폴더에 덮어쓰지 않는다. 출력 폴더를 반드시 따로 받는다.
 *   - 한 장이 실패해도 전체를 중단하지 않고 로그에 남기고 계속한다.
 *   - 문서를 순차적으로 열고 닫아 메모리 누적을 막는다.
 */

const { app, core } = require("photoshop");
const { storage } = require("uxp");
const fs = storage.localFileSystem;
const pipeline = require("./pipeline");

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

async function saveDocument(doc, outFolder, name, options) {
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

  if (outputFolder.nativePath === sourceFolder.nativePath) {
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
          await saveDocument(doc, outputFolder, outputName(entry.name, options), options);
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
