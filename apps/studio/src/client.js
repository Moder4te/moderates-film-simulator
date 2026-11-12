/**
 * 세션 클라이언트 — UI는 이것만 안다. 워커가 되면 워커로, 안 되면 같은 세션을
 * 메인 스레드에서 직접 돌린다(화면이 멎지만 **동작은 한다**).
 *
 * 워커 소스는 빌드가 문자열로 박아 준다(`tools/build-studio.js`). 파일 하나짜리
 * HTML로 배포하려면 별도 worker.js 파일을 둘 수 없어서 Blob URL로 띄운다.
 */

const { createSession } = require("./session");
const { browserEnv } = require("./env");

const METHODS = ["open", "preview", "exportImage", "exportLook", "close"];

function createClient(onProgress) {
  const source = typeof __FILMSIM_WORKER__ === "string" ? __FILMSIM_WORKER__ : null;
  let worker = null;
  if (source && typeof Worker !== "undefined") {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    } catch (e) {
      worker = null;
    }
  }

  const rawWasm = typeof __FILMSIM_RAW_WASM__ === "string" ? __FILMSIM_RAW_WASM__ : null;

  if (!worker) {
    const session = createSession(browserEnv(onProgress, () => rawWasm));
    const api = { threaded: false };
    for (const m of METHODS) api[m] = async (...args) => session[m](...args);
    return api;
  }

  worker.postMessage({ init: { rawWasm } });

  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.progress) { onProgress(d.progress.label, d.progress.fraction); return; }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error != null) p.reject(new Error(d.error));
    else p.resolve(d.result);
  };
  worker.onerror = (e) => {
    // 워커가 통째로 죽으면(대개 메모리) 기다리던 호출을 전부 깨운다
    for (const p of pending.values()) p.reject(new Error("처리 중 오류: " + (e.message || "워커가 멈췄습니다 — 메모리가 부족할 수 있습니다")));
    pending.clear();
  };

  const api = { threaded: true };
  for (const m of METHODS) {
    api[m] = (...args) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        // 연 파일의 바이트는 넘겨 버린다 — 메인에 사본을 남길 이유가 없다
        const transfer = m === "open" && args[0] instanceof ArrayBuffer ? [args[0]] : [];
        worker.postMessage({ id, method: m, args }, transfer);
      });
  }
  return api;
}

module.exports = { createClient };
