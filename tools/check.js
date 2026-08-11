#!/usr/bin/env node
/**
 * 전체 검사. **코드를 고쳤으면 실기에 올리기 전에 이걸 돌린다.**
 *
 *   node tools/check.js
 *
 * 순서에 의미가 있다 — 앞의 것이 실패하면 뒤의 것은 결과가 무의미하다.
 *
 *   1. 문법·BOM      파일이 파싱되는가. manifest BOM은 플러그인을 아예 못 올린다
 *   2. 경계          층이 지켜지는가. core 순수 / batchPlay 격리 / 마감 앱에 색 없음
 *   3. 경로          배치가 원본을 덮어쓸 길이 없는가 (되돌릴 수 없는 유일한 결함)
 *   4. 로드          두 앱이 예외 없이 뜨는가. 없는 id를 참조하지 않는가
 *   5. 함수          앱이 부르는 모듈 함수가 실제로 존재하는가
 *   6. 정합성        네 산출 경로가 같은 색을 내는가
 *   7. 톤            마감 그레이딩의 항등·단조성·중립 보존·디더
 *   8. 그레인        G1(채널상관)·G4(존 가중치 합)·G5(격자점수) 등을 값으로 못 박는다
 *      (docs/PLAN-GRAIN-2026-08-02.md "## 검증")
 *
 * 4번 이후는 `lib/`를 읽으므로 sync-libs를 먼저 돌린다.
 */

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
let failed = 0;

function step(name, fn) {
  process.stdout.write(`\n── ${name} ${"─".repeat(Math.max(0, 56 - name.length))}\n`);
  try {
    if (fn() === false) failed++;
  } catch (e) {
    failed++;
    console.error("  " + ((e && e.message) || e));
  }
}

function walk(dir, fn) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}

step("문법 · BOM", () => {
  let bad = 0;
  const seen = [];
  const lua = [];
  for (const dir of ["core", "host", "shared", "apps", "tools", "lrplugin"]) {
    walk(path.join(ROOT, dir), (p) => {
      if (p.includes(`${path.sep}lib${path.sep}`)) return; // 원본에서 이미 본다
      const raw = fs.readFileSync(p);
      if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        console.error(`  BOM: ${path.relative(ROOT, p)}`);
        bad++;
      }
      if (p.endsWith(".lua")) {
        lua.push(p);
        // Lua 인터프리터가 없어 문법은 못 본다. 대신 **여기서 확인 가능한 것**만
        // 못 박는다. 위 BOM 검사가 Lua에도 걸리는데, Lua 5.1은 BOM을 건너뛰지 않고
        // `unexpected symbol`로 죽는다 — 그리고 그건 Lightroom을 켜야만 드러난다.
        //
        // 인코딩도 본다. 메뉴 제목과 안내문이 전부 한글이라, 깨진 바이트가 섞이면
        // 대화상자가 통째로 읽을 수 없게 된다.
        if (Buffer.compare(Buffer.from(raw.toString("utf8"), "utf8"), raw) !== 0) {
          console.error(`  UTF-8 아님: ${path.relative(ROOT, p)}`);
          bad++;
        }

        // 맨 `pcall`은 금지다. Lua 5.1은 C 함수 경계를 넘어 yield하지 못하는데
        // `pcall`이 그 C 함수라, SDK의 비동기 호출을 감싸면 호출 자체가
        // "Yielding is not allowed within a C or metamethod call"로 죽는다.
        // 실기에서 한 번 밟았고, Lightroom을 켜야만 드러나는 종류라 여기서 막는다.
        raw
          .toString("utf8")
          .split(/\r?\n/)
          .forEach((line, i) => {
            const code = line.split("--")[0]; // 주석에 적은 설명은 보지 않는다
            if (/(?<!LrTasks\.)\bpcall\s*\(/.test(code)) {
              console.error(
                `  맨 pcall: ${path.relative(ROOT, p)}:${i + 1} — LrTasks.pcall을 쓸 것`
              );
              bad++;
            }
          });
      }
      if (p.endsWith(".js")) {
        seen.push(p);
        const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
        if (r.status !== 0) {
          console.error(`  문법: ${path.relative(ROOT, p)}`);
          console.error("    " + (r.stderr || "").split("\n")[1]);
          bad++;
        }
      }
      if (p.endsWith("manifest.json")) {
        try {
          JSON.parse(raw.toString("utf8"));
        } catch (e) {
          console.error(`  JSON: ${path.relative(ROOT, p)} — ${e.message}`);
          bad++;
        }
      }
    });
  }
  // 두 앱의 UI가 구조적으로 온전한가
  for (const app of ["engine", "finish"]) {
    const html = fs.readFileSync(path.join(ROOT, "apps", app, "index.html"), "utf8");
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    if (open !== close) {
      console.error(`  apps/${app}/index.html — div 불균형 ${open}/${close}`);
      bad++;
    }
  }
  console.log(
    `  JS ${seen.length}개 · manifest 2개 · HTML 2개 · Lua ${lua.length}개(BOM·인코딩·맨 pcall) 검사, 문제 ${bad}건`
  );
  return bad === 0;
});

step("동기화", () => {
  execFileSync(process.execPath, [path.join(__dirname, "sync-libs.js")], { stdio: "inherit" });
});

for (const [name, script] of [
  ["문서", "check-docs.js"],
  ["경계", "check-boundaries.js"],
  ["경로", "check-paths.js"],
  ["로드", "check-load.js"],
  ["함수", "check-api.js"],
  ["정합성", "check-conformance.js"],
  ["톤", "check-tone.js"],
  ["그레인", "check-grain.js"],
]) {
  step(name, () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: "inherit" });
    return r.status === 0;
  });
}

console.log(failed ? `\n검사 실패 ${failed}건` : "\n전체 검사 통과");
process.exit(failed ? 1 : 0);
