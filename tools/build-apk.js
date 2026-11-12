#!/usr/bin/env node
/**
 * FilmSim Studio를 Android APK로 묶는다.
 *
 *   node tools/build-apk.js        →  dist/FilmSimStudio-<버전>.apk
 *
 * APK 안에 든 것은 `dist/studio/index.html`(브라우저에서 여는 그 파일)과, 그것을
 * WebView에 띄우는 액티비티 하나(`apps/android`)다. 색·마감 코드는 한 줄도 다시 짜지
 * 않았다 — 껍데기는 파일 고르기와 저장만 이어 준다.
 *
 * ── 필요한 것 ───────────────────────────────────────────────────────────
 *
 *   JDK 17+            javac · keytool
 *   Android SDK        ANDROID_HOME(또는 ANDROID_SDK_ROOT)에
 *                        build-tools;<아무 버전>   aapt2 · d8 · zipalign · apksigner
 *                        platforms;android-35      android.jar
 *
 *   sdkmanager "platforms;android-35" "build-tools;36.0.0"
 *
 * ── 왜 Gradle이 아닌가 ──────────────────────────────────────────────────
 *
 * 자바 파일 하나에 리소스 둘이다. Gradle + Android 플러그인을 쓰면 플러그인과 그
 * 의존성 수백 MB를 받아야 하고 설정 파일이 소스보다 길어진다. SDK 도구를 차례로
 * 부르면 다섯 단계다. 이 저장소가 지켜 온 "의존성 0"과도 맞는다.
 *
 *   aapt2 compile/link   리소스·매니페스트 → 뼈대 APK (+ assets/index.html)
 *   javac → d8           액티비티 → classes.dex
 *   zipalign → apksigner 정렬 · 서명
 *
 * ── 서명 ────────────────────────────────────────────────────────────────
 *
 * 안드로이드는 **같은 키로 서명한 APK만** 기존 설치 위에 덮어 깐다. 그래서 키가
 * 바뀌면 지우고 다시 깔아야 한다(앱에 저장해 둔 프리셋이 지워진다).
 *
 *   FILMSIM_KEYSTORE        키 저장소 경로. 없으면 ~/.android/filmsim-studio.keystore를
 *                           쓰고, 그것도 없으면 그 자리에 새로 만든다
 *   FILMSIM_KEYSTORE_PASS   비밀번호(기본 "android" — 디버그 키의 관례)
 *   FILMSIM_KEY_ALIAS       키 이름(기본 "filmsim")
 *
 * ⚠️ 키 저장소를 **저장소에 커밋하지 말 것.** 그 키를 가진 사람은 누구나 이 앱의
 * "업데이트"를 만들 수 있다.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "apps/android");
const MIN_SDK = 29; // MediaStore로 권한 없이 저장하려면 Android 10부터다
const TARGET_SDK = 35;

function fail(msg) {
  console.error("build-apk: " + msg);
  process.exit(1);
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: "utf8" }, opts));
  if (r.error) fail(`${path.basename(cmd)} 실행 실패 — ${r.error.message}`);
  if (r.status !== 0) {
    // JAVA_TOOL_OPTIONS 안내 같은 잡음은 걸러 내고 진짜 오류만
    const text = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => !l.startsWith("Picked up ")).join("\n");
    fail(`${path.basename(cmd)} ${args[0] || ""} 실패\n${text.trim()}`);
  }
  return r.stdout;
}

/** SDK에서 도구 위치를 찾는다. build-tools는 설치된 것 중 가장 높은 버전. */
function findSdk() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "android-sdk");
  if (!fs.existsSync(home)) {
    fail(`Android SDK가 없습니다(${home}). ANDROID_HOME을 지정하거나 SDK를 설치하세요 — 이 파일 머리말 참조`);
  }
  const versions = (dir) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      : [];
  const bt = versions(path.join(home, "build-tools")).pop();
  if (!bt) fail("build-tools가 없습니다 — sdkmanager \"build-tools;36.0.0\"");
  const jar = path.join(home, "platforms", `android-${TARGET_SDK}`, "android.jar");
  if (!fs.existsSync(jar)) fail(`platforms;android-${TARGET_SDK}가 없습니다 — sdkmanager "platforms;android-${TARGET_SDK}"`);
  const exe = process.platform === "win32";
  const tool = (name, bat) => path.join(home, "build-tools", bt, name + (exe ? (bat ? ".bat" : ".exe") : ""));
  return {
    home, buildTools: bt, androidJar: jar,
    aapt2: tool("aapt2"), d8: tool("d8", true), zipalign: tool("zipalign"), apksigner: tool("apksigner", true),
  };
}

function keystore() {
  const file = process.env.FILMSIM_KEYSTORE || path.join(os.homedir(), ".android", "filmsim-studio.keystore");
  const pass = process.env.FILMSIM_KEYSTORE_PASS || "android";
  const alias = process.env.FILMSIM_KEY_ALIAS || "filmsim";
  let created = false;
  if (!fs.existsSync(file)) {
    if (process.env.FILMSIM_KEYSTORE) fail(`키 저장소가 없습니다: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    run("keytool", [
      "-genkeypair", "-keystore", file, "-storepass", pass, "-keypass", pass, "-alias", alias,
      "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
      "-dname", "CN=FilmSim Studio, O=Moderate's Film Simulator",
    ]);
    created = true;
  }
  return { file, pass, alias, created };
}

/** "0.1.0" → 100. 안드로이드는 이 정수가 커져야 업데이트로 받아 준다. */
function versionCode(v) {
  const [a, b, c] = v.split(".").map((n) => parseInt(n, 10) || 0);
  return a * 10000 + b * 100 + c;
}

function build() {
  const sdk = findSdk();
  const studio = require("./build-studio.js").build();
  const version = studio.version;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "filmsim-apk-"));
  const dir = (name) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); return d; };

  // 리소스 — 저장소의 것에 아이콘을 얹는다. 아이콘은 Studio의 것을 그대로 쓴다
  // (같은 그림을 저장소에 두 벌 두지 않는다). 192px이 xxxhdpi 런처 아이콘 크기다
  const res = dir("res");
  fs.cpSync(path.join(APP, "res"), res, { recursive: true });
  fs.mkdirSync(path.join(res, "mipmap-xxxhdpi"));
  fs.copyFileSync(path.join(ROOT, "apps/studio/icons/icon-192.png"), path.join(res, "mipmap-xxxhdpi/ic_launcher.png"));

  const assets = dir("assets");
  fs.copyFileSync(studio.file, path.join(assets, "index.html"));

  // 1. 리소스 → 뼈대 APK
  const compiled = path.join(work, "res.zip");
  run(sdk.aapt2, ["compile", "--dir", res, "-o", compiled]);
  const base = path.join(work, "base.apk");
  run(sdk.aapt2, [
    "link", "-o", base, "-I", sdk.androidJar,
    "--manifest", path.join(APP, "AndroidManifest.xml"),
    "--java", dir("gen"), "-A", assets,
    "--min-sdk-version", String(MIN_SDK), "--target-sdk-version", String(TARGET_SDK),
    "--version-code", String(versionCode(version)), "--version-name", version,
    compiled,
  ]);

  // 2. 자바 → dex
  const sources = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".java")) sources.push(p);
    }
  })(path.join(APP, "java"));
  const classes = dir("classes");
  run("javac", ["--release", "11", "-Xlint:-options", "-cp", sdk.androidJar, "-d", classes, ...sources]);
  const classFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".class")) classFiles.push(p);
    }
  })(classes);
  const dex = dir("dex");
  run(sdk.d8, ["--release", "--min-api", String(MIN_SDK), "--lib", sdk.androidJar, "--output", dex, ...classFiles]);

  // 3. dex를 APK에 넣는다. APK는 zip이다 — `jar`가 JDK에 있어 따로 zip 도구가 필요 없다
  run("jar", ["uf", base, "-C", dex, "classes.dex"]);

  // 4. 정렬 → 서명 (순서가 반대면 서명이 깨진다)
  const aligned = path.join(work, "aligned.apk");
  run(sdk.zipalign, ["-f", "-p", "4", base, aligned]);
  const ks = keystore();
  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `FilmSimStudio-${version}.apk`);
  run(sdk.apksigner, [
    "sign", "--ks", ks.file, "--ks-pass", `pass:${ks.pass}`, "--ks-key-alias", ks.alias,
    "--min-sdk-version", String(MIN_SDK), "--out", out, aligned,
  ]);
  // apksigner가 남기는 부속 파일(.idsig)은 설치에 필요 없다
  fs.rmSync(out + ".idsig", { force: true });
  run(sdk.apksigner, ["verify", "--min-sdk-version", String(MIN_SDK), out]);

  fs.rmSync(work, { recursive: true, force: true });
  return { out, version, sdk, ks };
}

module.exports = { build };

if (require.main === module) {
  const r = build();
  const mb = (fs.statSync(r.out).size / 1e6).toFixed(2);
  console.log(`${path.relative(ROOT, r.out)}  ${mb}MB · v${r.version} · Android ${MIN_SDK === 29 ? "10" : MIN_SDK}+ (build-tools ${r.sdk.buildTools})`);
  console.log(`  서명 키: ${r.ks.file}${r.ks.created ? "  ← 새로 만들었다. 이 파일을 보관해야 다음 판을 덮어 깔 수 있다" : ""}`);
  console.log("  설치: 폰으로 옮겨 열거나,  adb install -r " + path.relative(ROOT, r.out));
}
