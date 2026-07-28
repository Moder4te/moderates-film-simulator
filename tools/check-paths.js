#!/usr/bin/env node
/**
 * 경로 비교 검사 — 배치가 원본을 덮어쓰지 않는다는 보증의 뿌리.
 *
 *   node tools/check-paths.js
 *
 * `apps/finish/src/batch.js`의 `isSameFile`이 1차로 `shared/paths.js`의 `samePath`를
 * 쓴다. 여기가 틀리면 **원본 사진이 지워진다** — 되돌릴 수 없는 유일한 결함이다.
 * 그런데 실기에서 확인하려면 심볼릭 링크나 대소문자만 다른 폴더를 손으로 만들어야
 * 해서, 회귀가 나도 다음 실기까지 아무도 모른다. 그래서 경계값을 여기서 돌린다.
 *
 * 음성 방향도 함께 본다. 과잉 차단(다른 폴더를 같다고 판정)은 정상 배치를 통째로
 * 막으므로 그것도 결함이다.
 */

const path = require("path");
const { samePath } = require(path.resolve(__dirname, "../shared/paths.js"));

const B = "\\";
const problems = [];

// [a, b, 같은가, 왜 보는가]
const CASES = [
  // ── 뚫렸던 것들. 이전 구현은 `===` 하나였다 ────────────────────────────
  ["C:" + B + "Photos", "C:" + B + "photos", true, "Windows 대소문자"],
  ["C:" + B + "Photos" + B + "a.jpg", "C:" + B + "PHOTOS" + B + "A.JPG", true, "파일명 대소문자"],
  ["C:" + B + "Photos", "C:" + B + "Photos" + B, true, "후행 구분자"],
  ["C:" + B + "Photos", "C:/Photos", true, "구분자 혼용"],
  ["C:" + B + "a" + B + B + "b", "C:" + B + "a" + B + "b", true, "중복 구분자"],
  [B + B + "srv" + B + "Share" + B + "A", B + B + "SRV" + B + "share" + B + "a", true, "UNC 대소문자"],

  // ── 과잉 차단이면 안 되는 것들 ─────────────────────────────────────────
  ["C:" + B + "Photos", "C:" + B + "Photos2", false, "접두사가 같은 다른 폴더"],
  ["C:" + B + "Photos" + B + "out", "C:" + B + "Photos", false, "하위 폴더는 같지 않다"],
  ["C:" + B + "a" + B + "b.jpg", "C:" + B + "a" + B + "b_film.jpg", false, "접미사가 붙은 산출물"],
  ["D:" + B + "Photos", "C:" + B + "Photos", false, "드라이브가 다르다"],

  // ── POSIX ─────────────────────────────────────────────────────────────
  ["/Users/me/Photos/", "/Users/me/Photos", true, "POSIX 후행 구분자"],
  ["/Users/me/Photos", "/Users/me/photos", false, "POSIX는 대소문자를 구분한다"],
  ["/Users/me/Photos", "/Users/me/Pictures", false, "POSIX 다른 폴더"],
];

for (const [a, b, want, why] of CASES) {
  const got = samePath(a, b);
  if (got !== want) {
    problems.push(`${why} — samePath(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}, 기대 ${want}`);
  }
}

// 자기 자신과는 언제나 같아야 한다.
for (const [a] of CASES) {
  if (!samePath(a, a)) problems.push(`반사성이 깨졌다: ${JSON.stringify(a)}`);
}

// 대칭이어야 한다 — 인자 순서로 결과가 달라지면 호출부에 따라 방어가 새는 것과 같다.
for (const [a, b] of CASES) {
  if (samePath(a, b) !== samePath(b, a)) {
    problems.push(`대칭이 깨졌다: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
}

if (problems.length) {
  console.error("경로 비교 위반 " + problems.length + "건\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(
  `  OK  samePath 경계값 ${CASES.length}건 (대소문자 · 후행/중복 구분자 · UNC · 과잉 차단 없음 · 반사·대칭)`
);
console.log("\n경로 검사 통과 — 배치가 원본을 원본 이름으로 덮어쓸 길이 없다");
