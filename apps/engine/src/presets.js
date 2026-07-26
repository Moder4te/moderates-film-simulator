/**
 * 프리셋 저장소.
 * 플러그인 데이터 폴더에 프리셋 하나당 JSON 파일 하나로 저장한다.
 */

const { storage } = require("uxp");
const fs = storage.localFileSystem;
const { defaultParams, migrate } = require("./params");

const FOLDER_NAME = "presets";

async function presetFolder() {
  const dataFolder = await fs.getDataFolder();
  try {
    return await dataFolder.getEntry(FOLDER_NAME);
  } catch (e) {
    return dataFolder.createFolder(FOLDER_NAME);
  }
}

/** 파일명으로 쓸 수 없는 문자를 제거한다. */
function slugify(name) {
  return (
    String(name)
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 80) || "untitled"
  );
}

async function list() {
  const folder = await presetFolder();
  const entries = await folder.getEntries();
  const presets = [];

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    try {
      const text = await entry.read();
      const parsed = migrate(JSON.parse(text));
      presets.push({ fileName: entry.name, params: parsed });
    } catch (e) {
      // 손상된 프리셋 하나가 목록 전체를 막지 않도록 건너뛴다.
      console.error(`프리셋 읽기 실패: ${entry.name}`, e);
    }
  }

  presets.sort((a, b) => a.params.name.localeCompare(b.params.name));
  return presets;
}

async function save(params) {
  const folder = await presetFolder();
  const fileName = `${slugify(params.name)}.json`;
  const file = await folder.createFile(fileName, { overwrite: true });
  await file.write(JSON.stringify(params, null, 2));
  return fileName;
}

async function remove(fileName) {
  const folder = await presetFolder();
  const entry = await folder.getEntry(fileName);
  await entry.delete();
}

/** 사용자가 고른 위치로 프리셋 JSON을 내보낸다. */
async function exportToFile(params) {
  const file = await fs.getFileForSaving(`${slugify(params.name)}.json`, {
    types: ["json"],
  });
  if (!file) return null;
  await file.write(JSON.stringify(params, null, 2));
  return file.name;
}

/** 외부 JSON 프리셋을 가져와 데이터 폴더에 저장한다. */
async function importFromFile() {
  const file = await fs.getFileForOpening({ types: ["json"] });
  if (!file) return null;
  const parsed = migrate(JSON.parse(await file.read()));
  await save(parsed);
  return parsed;
}

/**
 * 최초 실행 시 참고용 시작 프리셋을 심는다.
 *
 * 엔진 프리셋이므로 **필름·스캐너·색 조정만** 담는다. 할레이션·그레인은 마감
 * 플러그인의 소관이라 여기 스키마에 아예 없다.
 */
async function seedIfEmpty() {
  const existing = await list();
  if (existing.length > 0) return;

  const warm = defaultParams();
  warm.name = "Warm Portrait";
  warm.film.id = "kodak-portra-400";
  warm.film.scanner = "frontier";
  warm.category = "Starter";
  warm.grading.selectiveColor.reds = { c: -6, m: 3, y: 8, k: 0 };
  warm.grading.selectiveColor.yellows = { c: -4, m: 0, y: 10, k: 0 };
  warm.grading.selectiveColor.neutrals = { c: -2, m: 1, y: 4, k: 0 };
  warm.grading.selectiveColor.blacks = { c: 4, m: 0, y: -3, k: 2 };
  warm.grading.toe = 30;
  warm.grading.shoulder = 20;

  const tungsten = defaultParams();
  tungsten.name = "Tungsten Night";
  tungsten.category = "Starter";
  tungsten.grading.selectiveColor.blues = { c: 12, m: 2, y: -8, k: 0 };
  tungsten.grading.selectiveColor.neutrals = { c: 5, m: 0, y: -6, k: 0 };
  tungsten.grading.toe = 15;
  tungsten.film.id = "kodak-portra-800";
  tungsten.film.scanner = "noritsu";

  await save(warm);
  await save(tungsten);
}

module.exports = { list, save, remove, exportToFile, importFromFile, seedIfEmpty };
