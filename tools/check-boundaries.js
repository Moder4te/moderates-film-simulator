#!/usr/bin/env node
/**
 * 아키텍처 경계 검사.
 *
 * 이 저장소의 구조는 **AI가 작업하다 넘나들기 쉬운 선**을 물리적으로 그은 것이다.
 * 사람은 규칙을 기억하지만 모델은 파일을 열어 보이는 대로 고친다. 그래서 규칙을
 * 문서가 아니라 **실행되는 검사**로 둔다.
 *
 *   node tools/check-boundaries.js
 *
 * 실패하면 되돌리지 말고 **왜 넘었는지** 먼저 볼 것. 대개는 코드가 잘못된 층에
 * 있다는 신호이지, 검사가 과한 것이 아니다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const problems = [];

function walk(dir, fn) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, fn);
    else if (p.endsWith(".js")) fn(p);
  }
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

// ── 1. core/ 는 순수해야 한다 ───────────────────────────────────────────
//
// 호스트 API를 부르는 순간 노드에서 테스트할 수 없게 되고, 그러면 색 계산의
// 검증 가능성이 사라진다. 지금 core/의 모든 모듈이 노드에서 그대로 돌고,
// 그래서 LUT 값을 전수 대조할 수 있다.
walk(path.join(ROOT, "core"), (p) => {
  const s = fs.readFileSync(p, "utf8");
  for (const mod of ["photoshop", "uxp"]) {
    if (s.includes(`require("${mod}")`)) {
      problems.push(`${rel(p)} — core/는 ${mod}를 부를 수 없다. 호스트 호출은 host/ 나 앱으로.`);
    }
  }
  if (/\bdocument\.(getElementById|createElement|querySelector)/.test(s)) {
    problems.push(`${rel(p)} — core/는 DOM을 만질 수 없다.`);
  }
});

// ── 2. batchPlay는 host/ 안에만 ─────────────────────────────────────────
//
// batchPlay 디스크립터는 문서화가 부실하고 오류 메시지가 엉뚱하다(UXP-NOTES 6.1).
// 추측으로 쓴 디스크립터는 조용히 틀리거나 무관한 에러를 뱉는다. 그래서 호출을
// 한곳에 모아 두고, 새 디스크립터는 반드시 **손으로 한 번 실행해 채록**한다.
walk(path.join(ROOT, "apps"), (p) => {
  if (rel(p).includes("/lib/")) return; // sync-libs가 복사한 것은 원본에서 이미 검사됨
  const s = fs.readFileSync(p, "utf8");
  if (/\baction\.batchPlay\s*\(/.test(s)) {
    problems.push(`${rel(p)} — batchPlay 직접 호출 금지. host/ps.js의 명명 함수를 쓸 것.`);
  }
});

// ── 2.5 디스크립터 여러 개를 내는 헬퍼는 반드시 펼쳐 쓴다 ───────────────
//
// `ps.stampVisible()`은 "빈 레이어 생성 + 병합" 두 개를 배열로 낸다. 펼치지 않고
// 그대로 넣으면 `play`에 배열이 하나 들어가 병합만 실행되거나 조용히 무시되고,
// 결과가 활성 레이어(배경) 안으로 들어가 **원본이 지워진다.** 실제로 그 일이 있었다.
//
// 새로 이런 헬퍼를 만들면 이 목록에 추가할 것.
const MULTI = ["stampVisible"];
walk(path.join(ROOT, "apps"), (p) => {
  if (rel(p).includes("/lib/")) return;
  const s = fs.readFileSync(p, "utf8");
  for (const fn of MULTI) {
    // 앞에 스프레드가 없는 호출을 찾는다
    const re = new RegExp(`(^|[^.])(\\bps\\.${fn}\\s*\\()`, "g");
    for (const m of s.matchAll(re)) {
      const before = s.slice(Math.max(0, m.index - 3), m.index + m[1].length);
      if (!before.endsWith("...")) {
        problems.push(`${rel(p)} — ps.${fn}()은 디스크립터를 여러 개 낸다. \`...\`로 펼칠 것.`);
      }
    }
  }
});

// ── 2.7 getPixels로 읽은 값은 정규화하고 색공간을 옮겨야 한다 ───────────
//
// 같은 버그가 세 번 났다. 16bit 문서에서 getPixels는 **0~32768**을 주는데(255가
// 아니다) 8bit로 가정하면 조용히 틀린다. 게다가 문서가 ProPhoto면 그 값을 sRGB로
// 옮기지 않고 쓰면 색이 어긋난다.
//
//   미리보기   16bit 문서에서 화면이 하얗게 날아갔다
//   미리보기   ProPhoto를 그대로 표시해 2/3스톱 어두웠다
//   사진 분석  두 가지를 다 빠뜨려 컬러휠 마커 6개가 한 점으로 뭉쳤다
//
// 8bit sRGB 문서로만 시험하면 셋 다 드러나지 않는다.
// 읽어서 되쓰는 **왕복** 경로는 예외다. 같은 공간·심도로 돌려주므로 표시 변환이
// 필요 없고, 심도는 lut.applyToBuffer 안에서 처리된다. 문제가 되는 것은 픽셀을
// **밖으로 내보내거나 판정에 쓰는** 경로다.
walk(path.join(ROOT, "apps"), (p) => {
  if (rel(p).includes("/lib/")) return;
  const s = fs.readFileSync(p, "utf8");
  if (!/imaging\.getPixels\s*\(/.test(s)) return;

  if (!/colorSpace:\s*"RGB"/.test(s)) {
    problems.push(`${rel(p)} — getPixels에 colorSpace: "RGB"가 없다. 그레이스케일·CMYK 문서에서 채널 수가 달라진다.`);
  }

  if (/imaging\.putPixels\s*\(/.test(s)) return; // 왕복 경로

  if (!/maxValueFor\s*\(/.test(s)) {
    problems.push(`${rel(p)} — getPixels 값을 쓰는데 심도 정규화가 없다. 16bit는 0~32768이다. lut.maxValueFor 참조.`);
  }
  if (!/displayConverter\s*\(/.test(s)) {
    problems.push(`${rel(p)} — 문서 색공간 변환이 없다. ProPhoto 값을 sRGB로 옮기지 않으면 색이 어긋난다.`);
  }
});

// ── 3. 마감 앱은 색을 몰라야 한다 ───────────────────────────────────────
//
// 두 플러그인으로 나눈 이유가 이것이다. 마감 쪽에 색 로직이 없으면 그쪽을
// 작업하다 색을 망가뜨릴 수 없다.
walk(path.join(ROOT, "apps/finish"), (p) => {
  if (rel(p).includes("/lib/")) return;
  const s = fs.readFileSync(p, "utf8");
  const m = s.match(/require\("[^"]*core\/color\/[^"]*"\)/);
  if (m) problems.push(`${rel(p)} — 마감 앱은 core/color를 참조할 수 없다: ${m[0]}`);
});
// lib에 실제로 복사되지 않았는지도 본다 (sync-libs.js의 LIBS 선언이 곧 경계다)
if (fs.existsSync(path.join(ROOT, "apps/finish/lib/core/color"))) {
  problems.push("apps/finish/lib/core/color — 마감 앱에 색 모듈이 반입됐다. tools/sync-libs.js의 LIBS 확인.");
}

// ── 4. 레이어 이름 접두사가 겹치면 안 된다 ──────────────────────────────
//
// 두 플러그인이 같은 문서에 겹쳐 쓰는 것이 정상 사용이다. 접두사를 공유하면
// 한쪽을 적용할 때 다른 쪽 결과가 지워진다.
function prefixOf(file) {
  const m = fs.readFileSync(path.join(ROOT, file), "utf8").match(/const PREFIX = "([^"]+)"/);
  return m && m[1];
}
const pe = prefixOf("apps/engine/src/pipeline.js");
const pf = prefixOf("apps/finish/src/pipeline.js");
if (!pe || !pf) problems.push("파이프라인의 PREFIX 상수를 찾지 못했다.");
else if (pe === pf || pe.startsWith(pf) || pf.startsWith(pe)) {
  problems.push(`레이어 접두사가 겹친다: engine="${pe}" finish="${pf}". 한쪽이 다른 쪽을 지운다.`);
}

// ── 5. 앱 진입 모듈의 require 경로 ──────────────────────────────────────
//
// UXP는 진입 모듈의 require를 플러그인 루트 기준으로 푼다(UXP-NOTES 2.1).
// 앱 밖(../)을 가리키면 개발 중에는 돌아도 패키징하면 파일이 빠져 죽는다.
for (const app of ["engine", "finish"]) {
  const p = path.join(ROOT, "apps", app, "src/main.js");
  if (!fs.existsSync(p)) continue;
  for (const m of fs.readFileSync(p, "utf8").matchAll(/require\("(\.[^"]+)"\)/g)) {
    if (m[1].startsWith("../")) {
      problems.push(`${rel(p)} — 진입 모듈이 앱 밖을 참조한다: ${m[1]} (패키징 시 빠진다)`);
    }
  }
}

// ── 6. 엔진 색 재적용이 중복되면 안 된다 ────────────────────────────────
//
// 두 가지가 깨지면 재적용 시 색이 누적되거나 마감(할레이션·그레인)이 색 레이어에
// 구워져 두 벌이 된다. 실기로만 드러나 회귀를 놓치기 쉬우므로 정적으로 못 박는다.
//
//   (a) pipeline.run이 clearOwnLayers를 부른다 — 이전 색 레이어를 안 지우면 누적.
//   (b) applyLut이 getPixels **전에** 다른 FilmSim 레이어를 숨긴다 — 합성본에
//       마감이 섞여 있으면 색에 구워진다. 숨겼으면 반드시 되돌린다.
(function checkEngineReapply() {
  const pipe = path.join(ROOT, "apps/engine/src/pipeline.js");
  const ap = path.join(ROOT, "apps/engine/src/apply.js");
  if (fs.existsSync(pipe)) {
    const s = fs.readFileSync(pipe, "utf8");
    if (!/async function clearOwnLayers\(/.test(s) || !/await clearOwnLayers\(/.test(s)) {
      problems.push("apps/engine/src/pipeline.js — run이 clearOwnLayers를 부르지 않는다. 재적용 색이 누적된다.");
    }
    if (!/l\.layers/.test(s)) {
      problems.push("apps/engine/src/pipeline.js — clearOwnLayers가 그룹 안(l.layers)을 재귀로 훑지 않는다. 중첩된 색 레이어를 못 지운다.");
    }
  }
  if (fs.existsSync(ap)) {
    const s = fs.readFileSync(ap, "utf8");
    const hide = s.indexOf(".visible = false");
    const get = s.indexOf("imaging.getPixels");
    if (!/startsWith\(FILMSIM\)/.test(s) || hide < 0) {
      problems.push("apps/engine/src/apply.js — applyLut이 다른 FilmSim 레이어를 격리(숨김)하지 않는다. 재적용 시 마감이 색에 구워진다.");
    } else if (get < 0 || hide > get) {
      problems.push("apps/engine/src/apply.js — 다른 FilmSim 레이어를 getPixels 전에 숨겨야 한다(순서 어긋남).");
    }
    if (!/\.visible = true/.test(s)) {
      problems.push("apps/engine/src/apply.js — 숨긴 레이어 가시성을 되돌리지 않는다(.visible = true 없음).");
    }
  }
  // (c) 미리보기도 getPixels 전에 FilmSim 레이어를 숨겨야 한다 — 안 그러면 적용된
  //     색을 다시 읽어 미리보기가 중복 적용된 것처럼 보인다.
  const pv = path.join(ROOT, "apps/engine/src/preview.js");
  if (fs.existsSync(pv)) {
    const s = fs.readFileSync(pv, "utf8");
    const hide = s.indexOf(".visible = false");
    const get = s.indexOf("imaging.getPixels");
    if (!/startsWith\("FilmSim"\)/.test(s) || hide < 0) {
      problems.push("apps/engine/src/preview.js — 미리보기가 FilmSim 레이어를 격리하지 않는다. 적용 후 미리보기가 중복으로 보인다.");
    } else if (get < 0 || hide > get) {
      problems.push("apps/engine/src/preview.js — FilmSim 레이어를 getPixels 전에 숨겨야 한다(순서 어긋남).");
    }
    if (!/\.visible = true/.test(s)) {
      problems.push("apps/engine/src/preview.js — 숨긴 레이어 가시성을 되돌리지 않는다.");
    }
  }
})();

if (problems.length) {
  console.error("경계 위반 " + problems.length + "건\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("경계 검사 통과 — core 순수 / batchPlay 격리 / 마감 앱 색 없음 / 접두사 분리");
