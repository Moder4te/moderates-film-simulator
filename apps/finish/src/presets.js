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
 * 마감 플러그인의 프리셋이므로 **매체·할레이션·그레인만** 담는다. 색은 엔진
 * 플러그인의 소관이라 여기 스키마에 아예 없다.
 */
async function seedIfEmpty() {
  const existing = await list();
  if (existing.length > 0) return;

  // 35mm 표준 — 입자가 보이고 할레이션은 절제된, 기본 참조점
  const classic = defaultParams();
  classic.name = "35mm Classic";
  classic.category = "Starter";

  // 야간 광원용 — 할레이션을 크게 열고 임계값을 낮춘다
  const night = defaultParams();
  night.name = "Night Halation";
  night.category = "Starter";
  night.halation.threshold = 200;
  night.halation.strength = 80;
  night.halation.radius = 1.6;
  night.halation.core = 80;
  night.halation.mid = 55;
  night.halation.bleed = 8;
  night.halation.disk = 60;
  night.halation.tintHue = 24;
  night.halation.tintSaturation = 70;
  night.grain.midtone = 55;

  // 중형 — 같은 입자여도 확대율이 낮아 곱게 나온다. 포맷 차이를 보여주는 예시
  const medium = defaultParams();
  medium.name = "120 Fine";
  medium.category = "Starter";
  medium.medium.format = "67";
  medium.grain.midtone = 35;
  medium.halation.strength = 30;

  // CineStill 800T — 강한 붉은 할레이션이 시그니처. 웹 작례 5장 실측으로 튜닝했다:
  // 하이라이트 주변 붉은 링이 코어 바로 밖 3~7px(이미지폭 ~1.5%)에서 피크(R/G
  // 1.5~1.9, R-B +0.4~0.5)를 이루고 ~5.5%까지 뻗는다. 색조 ~14°, 채도 ~65%.
  // ⚠️ 이 필름의 청록 섀도·전체 색감은 **색이라 엔진 소관**이다. 여기 프리셋은
  // 할레이션·그레인만 담는다(마감 스키마에 색이 없다). 색까지 원하면 엔진에서
  // 800T 프로파일을 함께 쓴다.
  const cine = defaultParams();
  cine.name = "CineStill 800T";
  cine.category = "Film";
  cine.grain.iso = 800; // ISO 800
  cine.halation.threshold = 155; // 붉은 네온 R 중앙값(~177)까지 걸리게 낮춤(실측)
  cine.halation.strength = 80;
  cine.halation.radius = 1.4; // bleed ×4 → ~5.6% 확산, 실측 범위와 일치
  cine.halation.core = 70;
  cine.halation.mid = 86; // 붉은 링 본체
  cine.halation.bleed = 85; // 넓은 붉은 헤일로가 강한 것이 특징
  cine.halation.disk = 70; // 경계 뚜렷한 원반형 번짐 (상한)
  cine.halation.tintHue = 14;
  cine.halation.tintSaturation = 90;

  await save(classic);
  await save(night);
  await save(medium);
  await save(cine);
}

module.exports = { list, save, remove, exportToFile, importFromFile, seedIfEmpty };
