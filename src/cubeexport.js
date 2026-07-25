/**
 * .cube 내보내기 — 엔진이 구운 LUT을 파일로 뽑는다.
 *
 * 왜 필요한가. v2의 목표는 Lightroom/ACR에서 쓰는 **프로파일(XMP)** 생성인데,
 * Adobe가 이미 변환 도구를 제공한다. Camera Raw의 Presets 패널에서 Alt를 누르고
 * New Preset을 누르면 "New Profile" 대화상자가 뜨고, Color Look-Up Table 항목에
 * .cube를 지정하면 크리에이티브 프로파일 XMP가 만들어진다. 즉 우리가 XMP 컨테이너
 * 인코딩을 직접 풀 필요가 없다 — **.cube까지만 만들면 된다.**
 *
 * 그래서 이 모듈이 v1(Photoshop 픽셀 적용)과 v2(프로파일 생성)를 잇는 다리다.
 *
 * ── 색공간 문제 ──────────────────────────────────────────────────────────
 *
 * LUT은 "입력 인코딩 값 → 출력 인코딩 값"의 사상이므로 **어느 인코딩을 전제로
 * 구웠는지**가 결과를 좌우한다. 우리 엔진은 ProPhoto γ1.8에서 굽는다(film.js).
 * Photoshop의 Color Lookup은 문서 색공간에서 적용하므로 ProPhoto 문서에 그대로
 * 맞고, 실제로 de-risk에서 수동 로드로 확인했다.
 *
 * Camera Raw도 **ProPhoto γ1.8을 쓰면 된다.** New Profile 대화상자의 Color Look-Up
 * Table 항목에 색공간 드롭다운이 있고(sRGB / Adobe RGB / P3 / ProPhoto RGB),
 * 거기서 ProPhoto RGB를 고르면 우리가 굽는 공간과 정확히 같다. 변환도 보간 손실도
 * 없다. **ACR에게 직접 알려주는 것이라 내부 공간을 추측할 필요가 없다.**
 *
 * 한동안 "ACR 내부 작업 공간은 ProPhoto 원색 + sRGB 톤 응답"이라는 추정을 근거로
 * 두 번째 선택지를 뒀다. 드롭다운의 존재로 그 추정 자체가 불필요해졌다. 다만
 * 드롭다운이 없는 경로(구버전 ACR, SDK 직접 생성 등)를 만날 수 있어 **폴백으로
 * 남겨둔다.** 지우는 것은 그런 경로가 없다고 확인한 뒤에 한다.
 */

const lut = require("./lut");
const film = require("./film");
const films = require("./films");
const scanner = require("./scanner");
const colorspace = require("./colorspace");
const { storage } = require("uxp");
const fs = storage.localFileSystem;

/**
 * 내보낼 수 있는 색공간.
 *
 * decode/encode는 **그 공간의 인코딩 ↔ 선형**이다. 원색이 ProPhoto로 같기
 * 때문에 이 한 쌍만 있으면 공간 사이를 오갈 수 있다.
 */
const SPACES = [
  {
    id: "prophoto",
    displayName: "ProPhoto γ1.8",
    note:
      "엔진 원본. 이걸 쓴다 — Photoshop Color Lookup(ProPhoto 문서), " +
      "그리고 Camera Raw New Profile에서 색공간을 ProPhoto RGB로 지정할 때.",
    cubeNote: "ProPhoto RGB (ROMM), gamma 1.8",
    decode: colorspace.prophotoDecode,
    encode: colorspace.prophotoEncode,
  },
  {
    id: "acr",
    displayName: "Camera Raw (폴백)",
    note:
      "ProPhoto 원색 + sRGB 톤 응답. New Profile에 색공간 드롭다운이 없을 때만 쓴다. " +
      "드롭다운이 있으면 ProPhoto 쪽이 정답이다.",
    cubeNote: "ProPhoto RGB primaries with sRGB tone response (Camera Raw working space)",
    decode: colorspace.srgbDecode,
    encode: colorspace.srgbEncode,
  },
];

const SPACE_BY_ID = new Map(SPACES.map((s) => [s.id, s]));

/** ACR/Photoshop이 표준으로 다루는 격자 크기. */
const SIZES = [33, 65];

function spaceById(id) {
  return SPACE_BY_ID.get(id) || SPACES[0];
}

/**
 * 엔진 공간(ProPhoto γ1.8)에서 구운 LUT을 다른 인코딩의 LUT으로 옮긴다.
 *
 * 표기: L은 X 인코딩 → X 인코딩 사상, 원하는 것은 Y → Y 사상 M이다.
 *
 *     M(y) = X→Y( L( Y→X(y) ) )
 *
 * 격자점을 옮기는 게 아니라 **격자를 새로 깔고 값을 다시 조회**해야 한다는 점이
 * 핵심이다. 값만 재인코딩하면 입력 축이 여전히 X 인코딩이라 톤이 어긋난다.
 *
 * 재조회에 보간이 들어가므로 원본보다 정보가 줄어든다. 곡선이 완만해서 실용상
 * 문제는 없지만, 정밀도가 필요하면 65격자를 쓰면 된다.
 */
function convertSpace(table, size, from, to) {
  if (from.id === to.id) return table;

  const out = new Float32Array(table.length);
  const tmp = [0, 0, 0];
  const coord = new Float64Array(size);
  const d = size - 1;

  // 입력 축: Y 인코딩 격자값 → 같은 광량의 X 인코딩 값 (조회에 쓸 좌표)
  for (let i = 0; i < size; i++) coord[i] = from.encode(to.decode(i / d));

  let p = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        lut.sample(table, size, coord[ri], coord[gi], coord[bi], tmp);
        out[p++] = to.encode(from.decode(tmp[0]));
        out[p++] = to.encode(from.decode(tmp[1]));
        out[p++] = to.encode(from.decode(tmp[2]));
      }
    }
  }
  return out;
}

/** 파일 이름에 쓸 수 있는 형태로. */
function slugify(text) {
  return (
    String(text)
      .trim()
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "filmsim"
  );
}

/**
 * 현재 파라미터로 만들어질 파일 이름. UI에 미리 보여주는 용도이기도 하다.
 * 노광·스캐너·격자·색공간이 다 들어가야 여러 벌 뽑았을 때 구분된다.
 */
function suggestName(params, opts) {
  const o = opts || {};
  const size = o.size || SIZES[0];
  const space = spaceById(o.space);
  const f = films.byId(params.film.id);
  const sc = scanner.byId(params.film.scanner);

  const parts = [slugify(f.displayName)];
  if (sc.id !== "none") parts.push(slugify(sc.displayName));
  const ev = params.film.exposure || 0;
  if (ev) parts.push(`${ev > 0 ? "+" : ""}${ev}EV`);
  parts.push(`${size}`);
  parts.push(space.id);
  return `${parts.join("_")}.cube`;
}

/** .cube 헤더 제목. 파일 안에서도 무엇인지 알 수 있어야 한다. */
function title(params, opts) {
  const o = opts || {};
  const f = films.byId(params.film.id);
  const sc = scanner.byId(params.film.scanner);
  const ev = params.film.exposure || 0;
  const evText = ev ? `${ev > 0 ? "+" : ""}${ev}EV` : "0EV";
  const scText = sc.id === "none" ? "no scanner" : sc.displayName;
  return `FilmSim ${f.displayName} / ${scText} / ${evText}`;
}

/**
 * 현재 파라미터로 .cube 텍스트를 만든다. 파일 저장과 분리해 두면 테스트할 수 있다.
 *
 * @param {object} params  패널 파라미터 전체
 * @param {object} [opts]  { size, space }
 */
function build(params, opts) {
  const o = opts || {};
  const size = SIZES.includes(o.size) ? o.size : SIZES[0];
  const space = spaceById(o.space);

  if (!params.film || !params.film.enabled) {
    throw new Error("필름 시뮬레이션이 꺼져 있습니다. 켜고 다시 시도하세요.");
  }

  // buildForParams가 유제 → 스캐너 → 사용자 조정까지 다 굽는다.
  // 즉 내보낸 .cube는 "현재 문서에 적용"과 같은 결과를 낸다.
  const native = film.buildForParams(params, size);
  const table = convertSpace(native, size, SPACES[0], space);

  return lut.toCube(table, size, title(params, opts), space.cubeNote);
}

/**
 * 사용자가 고른 위치에 .cube를 저장한다.
 * @returns {string|null} 저장한 파일 이름. 취소하면 null.
 */
async function exportToFile(params, opts) {
  // 굽기 전에 먼저 막는다. getFileForSaving은 파일을 만들어 버리므로, 대화상자
  // 뒤에서 실패하면 0바이트 파일이 남는다.
  if (!params.film || !params.film.enabled) {
    throw new Error("필름 시뮬레이션이 꺼져 있습니다. 켜고 다시 시도하세요.");
  }

  const file = await fs.getFileForSaving(suggestName(params, opts), {
    types: ["cube"],
  });
  if (!file) return null;

  // 65격자는 27만 점이라 몇 초 걸린다. 취소 가능성을 없앤 뒤에 굽는다.
  await file.write(build(params, opts));
  return file.name;
}

module.exports = {
  SPACES,
  SIZES,
  spaceById,
  convertSpace,
  suggestName,
  title,
  build,
  exportToFile,
};
