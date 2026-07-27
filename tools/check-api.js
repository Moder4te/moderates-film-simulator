/**
 * 앱이 부르는 `모듈.함수()`가 그 모듈에 **실제로 있는지** 확인한다.
 *
 * ⚠️ 이 검사가 없어서 `.cube`·프로파일 내보내기가 런타임에 죽고 있었다
 * (`cubeexport.exportToFile is not a function`). `core/io`는 직렬화만 하고 파일
 * 쓰기는 앱 몫인데, main.js가 core에 파일 함수를 기대했다.
 *
 * check-load는 **모듈 로드만** 확인하고 호출까지는 보지 않아 통과했다. 버튼을
 * 눌러 봐야만 드러나는 종류라 정적으로 잡을 값어치가 있다.
 *
 * 한계 — `module.exports = { ... }` 리터럴만 읽는다. 동적 할당은 못 본다.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const apps = ["engine", "finish"];
const problems = [];

for (const app of apps) {
  const dir = path.join(ROOT, "apps", app, "src");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const file = path.join(dir, f);
    const src = fs.readFileSync(file, "utf8");

    // const NAME = require("PATH")
    const mods = {};
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\("([^"]+)"\)/g)) {
      mods[m[1]] = m[2];
    }
    // const { a, b } = require(...) 는 구조분해라 별도 확인 불필요(로드 시 터짐)

    // ⚠️ **진입 모듈(main.js)의 require는 플러그인 루트 기준으로 풀린다**(UXP-NOTES 2.1).
    // 이걸 빠뜨려 처음 만든 검사가 main.js를 통째로 건너뛰었다 — 음성 테스트로 잡았다.
    const base = f === "main.js" ? path.join(ROOT, "apps", app) : path.dirname(file);

    for (const [alias, rel] of Object.entries(mods)) {
      if (rel === "photoshop" || rel === "uxp") continue;
      let target = path.resolve(base, rel);
      if (!target.endsWith(".js")) target += ".js";
      if (!fs.existsSync(target)) {
        problems.push(
          `apps/${app}/src/${f}  →  require("${rel}") 경로에 파일이 없다`
        );
        continue;
      }

      const modSrc = fs.readFileSync(target, "utf8");
      // module.exports = { ... } 안의 키.
      //
      // ⚠️ 처음엔 닫는 `}` 앞에 줄바꿈을 요구했더니 **한 줄짜리 export를 통째로
      // 건너뛰었다**(`module.exports = { a, b };`). 검사가 조용히 no-op이 됐고
      // 음성 테스트로만 드러났다 — **통과했다고 검사가 실제로 도는 것은 아니다.**
      const em = modSrc.match(/module\.exports\s*=\s*\{([^}]*)\}/);
      if (!em) continue;
      const exported = new Set(
        em[1]
          .split(",")
          .map((s) => s.split(":")[0].trim())
          .filter((s) => /^\w+$/.test(s))
      );

      const used = new Set();
      for (const u of src.matchAll(new RegExp("\\b" + alias + "\\.(\\w+)\\s*\\(", "g"))) {
        used.add(u[1]);
      }
      for (const fn of used) {
        if (!exported.has(fn)) {
          problems.push(
            `apps/${app}/src/${f}  →  ${alias}.${fn}()  없음 (${path.relative(ROOT, target).replace(/\\/g, "/")})`
          );
        }
      }
    }
  }
}

if (problems.length) {
  console.error("없는 함수 호출 " + problems.length + "건\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("함수 호출 검사 통과 — 앱이 부르는 모듈 함수가 전부 존재한다");
