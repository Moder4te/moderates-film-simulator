#!/usr/bin/env node
/**
 * 공유 층(`core/` `host/` `shared/`)을 각 앱의 `lib/`로 복사한다.
 *
 * 왜 복사인가. `.ccx`는 **manifest가 있는 폴더만** 담는다(tools/build-ccx.js 참고).
 * 앱 밖에 있는 `core/`를 `require("../../core/...")`로 참조하면 개발 중에는 돌지만
 * 패키징하면 그 파일들이 빠져 로드 시점에 죽는다. 심볼릭 링크는 Windows에서
 * 권한이 필요해 협업 시 깨진다.
 *
 * 그래서 **`core/`가 유일한 원본**이고 `apps/<app>/lib/`는 산출물이다.
 * `.gitignore`에 들어 있고, 여기를 직접 고치면 다음 sync에 지워진다.
 *
 * 어느 앱에 무엇을 넣는지가 곧 **경계**다. `engine`만 색을 알고 `finish`는 모른다.
 *
 *   node tools/sync-libs.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/**
 * 앱별 반입 목록. **여기가 아키텍처 경계의 선언이다.**
 *
 * finish에 `core/color`가 없는 것이 핵심이다 — 마감 플러그인은 필름 색 로직을
 * 물리적으로 가지고 있지 않으므로, 실수로든 의도로든 건드릴 수 없다.
 */
const LIBS = {
  engine: ["core/color", "core/io", "host", "shared"],
  finish: ["core/optics", "host", "shared"],
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

let total = 0;
for (const [app, dirs] of Object.entries(LIBS)) {
  const lib = path.join(ROOT, "apps", app, "lib");
  fs.rmSync(lib, { recursive: true, force: true });
  for (const rel of dirs) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`없는 경로: ${rel}`);
    copyDir(src, path.join(lib, rel));
  }
  const count = dirs.reduce((n, rel) => {
    const walk = (p) =>
      fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).reduce((a, f) => a + walk(path.join(p, f)), 0)
        : 1;
    return n + walk(path.join(ROOT, rel));
  }, 0);
  total += count;
  console.log(`apps/${app}/lib  ←  ${dirs.join(" ")}  (${count}개)`);
}
console.log(`총 ${total}개 파일 동기화`);
