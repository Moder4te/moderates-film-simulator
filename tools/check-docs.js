#!/usr/bin/env node
/**
 * 문서 링크 검사 — 마크다운 안의 앵커·파일 링크가 실제로 가리키는 곳이 있는가.
 *
 *   node tools/check-docs.js
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 *
 * 이 저장소는 **문서가 작업 지시서**다. `TODO.md`는 "맥락 없이 이것만 읽고 착수할 수
 * 있게" 적는 것이 규칙이고(그 파일 머리), 항목끼리 링크로 얽혀 있다. 그런데 제목을
 * 다듬으면 그 항목을 가리키던 링크가 조용히 죽는다 — **문서가 렌더링은 멀쩡하고
 * 클릭만 안 된다.**
 *
 * 실제로 밟았다. `C3`의 제목을 「영상용 Rec.709 `.cube`」에서 「… — 출력 쪽만
 * 남았다」로 바꾸면서 목차의 링크를 안 고쳤고, 그 상태로 커밋까지 갔다. 손으로 돌리던
 * 임시 스크립트가 나중에야 잡았다. 손으로 돌리는 검사는 안 돌린 것과 같다.
 *
 * ── GitHub 앵커 규칙 ────────────────────────────────────────────────────
 *
 * 제목 → 앵커 변환은 GitHub 규칙을 따른다. 소문자로 내리고, **글자·숫자·공백·하이픈만
 * 남기고**, 공백을 하이픈으로 바꾼다. ⚠️ 공백을 **하나씩** 바꾼다 — 연속 공백을
 * 합치면 안 된다. `제목 — 부제`처럼 em dash가 낀 제목은 dash가 지워지고 양옆 공백이
 * 남아 하이픈 **두 개**가 된다(`제목--부제`). 처음에 `\\s+`로 합쳤다가 멀쩡한 링크를
 * 전부 깨진 것으로 보고했다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** 검사할 문서. 저장소가 스스로 관리하는 것만 본다(archive는 과거 기록이라 뺀다). */
function targets() {
  const out = ["README.md", "TODO.md"];
  const docs = path.join(ROOT, "docs");
  for (const f of fs.readdirSync(docs)) {
    if (f.endsWith(".md")) out.push(path.join("docs", f));
  }
  out.push("tools/README.md");
  return out.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** 코드 블록 안의 내용은 링크도 제목도 아니다. */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
}

let pass = true;
const check = (name, ok, detail) => {
  if (!ok) pass = false;
  console.log(`  ${ok ? "OK  " : "❌  "}${name}${detail ? "  " + detail : ""}`);
};

let totalAnchors = 0;
let totalLinks = 0;
const broken = [];

for (const rel of targets()) {
  const full = path.join(ROOT, rel);
  const text = stripCode(fs.readFileSync(full, "utf8"));

  const anchors = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) anchors.add(slug(m[1]));
  totalAnchors += anchors.size;

  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    totalLinks++;

    const hash = href.indexOf("#");
    const filePart = hash < 0 ? href : href.slice(0, hash);
    const anchorPart = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));

    // 같은 문서 안의 앵커
    if (!filePart) {
      if (!anchors.has(anchorPart)) broken.push(`${rel} → #${anchorPart} (제목 없음)`);
      continue;
    }

    // 다른 파일 — 존재부터
    const targetPath = path.resolve(path.dirname(full), filePart);
    if (!fs.existsSync(targetPath)) {
      broken.push(`${rel} → ${filePart} (파일 없음)`);
      continue;
    }
    // 그 파일 안의 앵커까지
    if (anchorPart && targetPath.endsWith(".md")) {
      const other = stripCode(fs.readFileSync(targetPath, "utf8"));
      const otherAnchors = new Set();
      for (const m2 of other.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) otherAnchors.add(slug(m2[1]));
      if (!otherAnchors.has(anchorPart)) {
        broken.push(`${rel} → ${filePart}#${anchorPart} (제목 없음)`);
      }
    }
  }
}

check(
  `문서 링크 ${totalLinks}건이 전부 살아 있다`,
  broken.length === 0,
  broken.length ? "\n      " + broken.join("\n      ") : `제목 ${totalAnchors}개 대조`
);

// 앵커 변환 규칙 자체의 회귀 검사. em dash 제목이 정확히 하이픈 둘이 되어야 한다 —
// 여기가 틀리면 위 검사가 **멀쩡한 링크를 깨진 것으로** 보고한다(실제로 그랬다).
check(
  "앵커 규칙 — em dash는 하이픈 둘",
  slug("W1. 해상도 경고 — 조용히 틀리는 마지막 경로") === "w1-해상도-경고--조용히-틀리는-마지막-경로",
  slug("W1. 해상도 경고 — 조용히 틀리는 마지막 경로")
);
check(
  "앵커 규칙 — 백틱·마침표는 사라진다",
  slug("C1. `.cube` 폴백 색공간 정리") === "c1-cube-폴백-색공간-정리",
  slug("C1. `.cube` 폴백 색공간 정리")
);

console.log(pass ? "\n✅ 전 항목 통과" : "\n❌ 실패 항목 있음");
process.exit(pass ? 0 : 1);
