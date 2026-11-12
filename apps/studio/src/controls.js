/**
 * 컨트롤 표 — 패널에 무엇이 어떤 순서로 나오는가.
 *
 * 화면은 이 표에서 만들어진다(`main.js`). 슬라이더 하나를 더하려면 여기 한 줄이면
 * 되고, 값은 전부 **프리셋 스키마의 경로**로 가리킨다 — 화면 상태와 저장 형식이
 * 따로 놀 수 없다. 범위는 Photoshop 패널(apps/engine · apps/finish의 index.html)과
 * 같게 뒀다. 같은 프리셋이 양쪽에서 같은 자리에 와야 한다.
 */

const films = require("../../../core/color/films");
const paper = require("../../../core/color/paper");
const inputs = require("../../../core/color/inputs");
const scanner = require("../../../core/color/scanner");
const format = require("../../../core/optics/format");
const { SELECTIVE_COLOR_RANGES } = require("./params");

const range = (path, label, min, max, step, extra) =>
  Object.assign({ type: "range", path, label, min, max, step }, extra || {});
const select = (path, label, options, extra) =>
  Object.assign({ type: "select", path, label, options }, extra || {});
const check = (path, label, extra) => Object.assign({ type: "check", path, label }, extra || {});
const named = (list) => list.map((x) => [x.id, x.displayName]);

const RANGE_NAMES = {
  reds: "레드", yellows: "옐로", greens: "그린", cyans: "시안", blues: "블루", magentas: "마젠타",
  whites: "화이트", neutrals: "뉴트럴", blacks: "블랙", skin: "피부톤",
};

const SECTIONS = [
  {
    id: "film", title: "필름", enable: "film.enabled", open: true,
    hint: "유제 → 인화지 → 스캐너. TDS 특성곡선에서 굽는다.",
    items: [
      select("film.id", "필름", films.all().map((f) => [f.id, `${f.displayName} · ISO ${f.iso}`])),
      range("film.exposure", "노광", -2, 2, 0.1, { unit: "스톱", signed: true }),
      select("film.input", "입력 소스", named(inputs.applyable()), {
        hint: "파일의 코드값이 무슨 광량인가. 톤 커브 없이 현상한 파일이면 「리니어」, Camera Raw로 그냥 현상했으면 「ACR 역산」.",
      }),
      select("film.paper", "인화지", named(paper.all())),
      select("film.scanner", "스캐너", named(scanner.all())),
      select("film.lutSize", "내보내기 정밀도", [[33, "33³ 일반"], [65, "65³ 정밀"]], { number: true }),
      check("film.dodgeBurn.enabled", "닷지·번 (실험적)", { hint: "명암 넓은 장면을 인화 단계에서 눌러 담는다. 리니어·ACR 역산 입력용." }),
      range("film.dodgeBurn.limit", "닷지·번 한계", 0.15, 1, 0.05, { when: "film.dodgeBurn.enabled" }),
      range("film.dodgeBurn.contrast", "닷지·번 대비 복원", 0, 1, 0.05, { when: "film.dodgeBurn.enabled" }),
    ],
  },
  {
    id: "grading", title: "색 조정", enable: "grading.enabled",
    hint: "필름 룩 위에 얹는다. 색역 판정은 sRGB 기준.",
    items: [
      range("grading.toe", "발끝", 0, 100, 1),
      range("grading.shoulder", "어깨", 0, 100, 1),
      range("grading.channelGain.r", "R 게인", 0.5, 1.5, 0.01),
      range("grading.channelGain.g", "G 게인", 0.5, 1.5, 0.01),
      range("grading.channelGain.b", "B 게인", 0.5, 1.5, 0.01),
      { type: "selective", label: "색역별 보정", ranges: SELECTIVE_COLOR_RANGES.map((r) => [r, RANGE_NAMES[r] || r]) },
      select("grading.method", "보정 방식", [["relative", "상대 (기존 농도에 비례)"], ["absolute", "절대"]]),
      range("grading.skinHue", "피부 색상각", 0, 60, 0.5, { unit: "°" }),
      range("grading.skinRange", "피부 범위", 0, 100, 1),
      check("grading.protectSkin", "피부 보호 (레드·옐로 조정이 피부를 비켜 간다)"),
      check("grading.crosstalk.enabled", "크로스토크"),
      range("grading.crosstalk.amount", "크로스토크 양", 0, 40, 0.5, { unit: "%", when: "grading.crosstalk.enabled" }),
    ],
  },
  {
    id: "tone", title: "톤", enable: "tone.enabled",
    hint: "마감의 미세 조정. 광학 효과보다 먼저 걸린다 — 할레이션이 조정된 하이라이트에서 번진다.",
    items: [
      range("tone.exposure", "노출", -2, 2, 0.05, { unit: "스톱", signed: true }),
      range("tone.contrast", "대비", -50, 50, 1, { signed: true }),
      range("tone.shadows", "암부", -100, 100, 1, { signed: true }),
      range("tone.highlights", "명부", -100, 100, 1, { signed: true }),
      range("tone.black", "흑점", 0, 50, 1),
      range("tone.temp", "색온도", -100, 100, 1, { signed: true }),
      range("tone.tint", "틴트", -100, 100, 1, { signed: true }),
      range("tone.saturation", "채도", -100, 100, 1, { signed: true }),
      range("tone.vibrance", "바이브런스", -100, 100, 1, { signed: true }),
    ],
  },
  {
    id: "halation", title: "할레이션", enable: "halation.enabled",
    hint: "밝은 곳에서 붉게 번지는 빛. 작은 반짝임은 희미하게, 큰 광원은 진하게.",
    items: [
      range("halation.threshold", "문턱", 64, 250, 1),
      range("halation.strength", "강도", 0, 100, 1),
      range("halation.radius", "반경", 0.2, 6, 0.1, { unit: "%" }),
    ],
  },
  {
    id: "grain", title: "그레인", enable: "grain.enabled",
    hint: "입자 크기는 감도·포맷·해상도에서 나온다. 「1:1」로 봐야 실제 크기가 보인다.",
    items: [
      range("grain.iso", "감도", format.MIN_ISO, format.MAX_ISO, 1, { log: true, unit: "ISO", prefixUnit: true }),
      range("grain.shadow", "암부 강도", 0, 100, 1),
      range("grain.midtone", "중간톤 강도", 0, 100, 1),
      range("grain.highlight", "명부 강도", 0, 100, 1),
      range("grain.crossover1", "암부↔중간톤 경계", 0, 254, 1),
      range("grain.crossover2", "중간톤↔명부 경계", 0, 254, 1),
      range("grain.feather", "경계 부드러움", 0, 120, 1),
      range("grain.diffusion", "번짐", 0, 100, 1, { hint: "입자보다 고운 디테일을 지운다." }),
      check("grain.diffuseDisplace", "번짐을 변위로 (끄면 블러)"),
      range("grain.clump", "덩어리", 0, 100, 1),
      range("grain.dyeSpread", "채널 분화", 0, 100, 1, { hint: "청색 입자를 더 시끄럽게. 컬러 모드에서만." }),
      select("grain.colorMode", "입자 색", [["rgb", "컬러 (채널마다 독립)"], ["mono", "모노 (채널 공유)"]]),
    ],
  },
  {
    id: "medium", title: "매체", open: false,
    hint: "필름면 기준. 그레인과 할레이션이 함께 쓴다.",
    items: [
      select("medium.format", "포맷", format.all().map((f) => [f.id, `${f.displayName} — ${f.note}`])),
      select("medium.reference", "입자 크기 기준", format.references().map((r) => [r.id, `${r.displayName} — ${r.note}`])),
      { type: "number", path: "medium.customLongEdge", label: "직접 입력 긴 변 (px)", min: format.MIN_LONG_EDGE, max: 30000, step: 1, when: (p) => p.medium.reference === "custom" },
    ],
  },
];

module.exports = { SECTIONS, RANGE_NAMES };
