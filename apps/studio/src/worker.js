/**
 * 워커 — 세션을 메인 스레드 밖에서 돌린다. 24MP 내보내기가 10초 안팎이라
 * 메인에서 돌리면 그동안 화면이 멎는다.
 *
 * 프로토콜은 한 줄이다: { id, method, args } → { id, result } | { id, error }.
 * 진행 표시는 id 없이 { progress } 로 흘려보낸다.
 */

const { createSession } = require("./session");
const { browserEnv } = require("./env");

const session = createSession(browserEnv((label, fraction) => postMessage({ progress: { label, fraction } })));

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const result = await session[method](...args);
    // 픽셀 버퍼는 복사하지 않고 넘긴다
    const transfer = result && result.rgba ? [result.rgba.buffer] : [];
    postMessage({ id, result }, transfer);
  } catch (err) {
    postMessage({ id, error: (err && err.message) || String(err) });
  }
};
