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

if (problems.length) {
  console.error("경계 위반 " + problems.length + "건\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("경계 검사 통과 — core 순수 / batchPlay 격리 / 마감 앱 색 없음 / 접두사 분리");
