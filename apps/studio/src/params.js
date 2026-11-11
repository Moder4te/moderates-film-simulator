/**
 * 독립 실행형 파라미터 — **엔진 스키마와 마감 스키마를 한 객체에.**
 *
 * 새 스키마를 만들지 않는다. 두 플러그인의 `migrate`가 원래부터 서로의 키를 버리지
 * 않고 통과시키게 돼 있어서(v1.x 통합 프리셋을 둘 다 읽으라고 — `shared/params`),
 * 둘을 차례로 태우면 그대로 합쳐진다. 그래서 여기서 저장한 프리셋 JSON을 Photoshop
 * 엔진·마감 플러그인이 각자 자기 부분만 읽을 수 있고, 반대 방향도 된다.
 */

const engine = require("../../../shared/params/engine");
const finish = require("../../../shared/params/finish");

function migrate(raw) {
  const p = finish.migrate(engine.migrate(raw));
  p.kind = "studio";
  // 크로스토크는 슬라이더(amount)가 원본이고 행렬은 거기서 나온다 — 엔진 패널과 같다
  const ct = p.grading.crosstalk;
  if (ct.matrix) ct.amount = engine.crosstalkAmountFromMatrix(ct.matrix);
  return p;
}

function defaultParams() {
  return migrate({});
}

/** 경로("grain.iso")로 읽고 쓴다. UI 컨트롤 표가 경로로 값을 가리킨다. */
function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
  if (path === "grading.crosstalk.amount") {
    obj.grading.crosstalk.matrix = engine.crosstalkMatrixFromAmount(value);
  }
}

/**
 * 처음 실행할 때 심는 시작 프리셋. 마감 플러그인의 시드 넷과 같은 값이다
 * (`apps/finish/src/presets.js`) — 색은 기본(Portra 400)에서 시작한다.
 */
function seeds() {
  const mk = (name, category, edit) => {
    const p = defaultParams();
    p.name = name;
    p.category = category;
    edit(p);
    return p;
  };
  return [
    mk("35mm Classic", "Starter", () => {}),
    mk("Night Halation", "Starter", (p) => {
      p.halation.threshold = 135; p.halation.strength = 70; p.halation.radius = 1.6;
      p.grain.midtone = 55;
    }),
    mk("120 Fine", "Starter", (p) => {
      p.medium.format = "67"; p.grain.midtone = 35; p.halation.strength = 25;
    }),
    mk("CineStill 800T", "Film", (p) => {
      p.film.id = "kodak-vision3-500t";
      p.grain.iso = 800;
      p.halation.threshold = 120; p.halation.strength = 80; p.halation.radius = 1.4;
    }),
  ];
}

module.exports = {
  defaultParams, migrate, get, set, seeds,
  SELECTIVE_COLOR_RANGES: engine.SELECTIVE_COLOR_RANGES,
};
