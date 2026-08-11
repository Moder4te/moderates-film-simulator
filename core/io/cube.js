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

const lut = require("../color/lut");
const film = require("../color/film");
const films = require("../color/films");
const scanner = require("../color/scanner");
const colorspace = require("../color/colorspace");

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

/**
 * 입력 전달함수 — **소스 영상이 무엇으로 인코딩돼 있는가.**
 *
 * `SPACES`가 "입력·출력 인코딩이 같은" 사진용 LUT을 위한 것이라면, 이쪽은
 * **비대칭 LUT**을 위한 것이다. 로그 촬영본에 거는 룩 LUT은 원래 그런 모양이다 —
 * 로그가 들어가고 표시용 값이 나온다.
 *
 * 왜 `SPACES`에 항목 하나 더 얹는 것으로 안 되는가:
 *
 *   1. **범위.** S-Log3 코드 0~1은 선형 −0.014~38.4를 덮는다. 엔진 LUT의 정의역은
 *      선형 0~1뿐이라, 이미 구운 LUT을 재격자하면 **코드 0.596 위가 통째로 흰색으로
 *      뭉개진다**(코드 범위의 40%, 하이라이트 4.4스톱). 그래서 재격자가 아니라
 *      **처음부터 그 전달함수로 굽는다**(`film.buildForParams`의 `input`).
 *   2. **원색.** S-Gamut3.Cine은 ProPhoto와 원색이 달라 3×3이 필요하다. `SPACES`는
 *      "원색이 같다"를 전제로 만들어졌다(위 `convertSpace` 주석).
 *
 * ⚠️ **출력 인코딩은 `space`가 정한다.** 표시용으로 쓸 것이므로 `acr`(ProPhoto 원색 +
 * sRGB 톤 응답)이 실용적인 선택이다. 진짜 Rec.709 OETF는 아직 없다 → TODO C3.
 */
const INPUTS = [
  {
    id: "engine",
    displayName: "엔진 기본 (ProPhoto γ1.8)",
    note: "사진용. 입력·출력 인코딩이 같다.",
  },
  {
    id: "slog3",
    displayName: "Sony S-Log3 / S-Gamut3.Cine",
    note:
      "로그 촬영본용 룩 LUT. 입력은 S-Log3(18% 그레이 = 코드 0.41056, 코드 1.0 = 선형 38.4), " +
      "출력은 선택한 색공간이다. 원색은 S-Gamut3.Cine → ProPhoto로 변환한다. " +
      "⚠️ 비대칭 LUT이라 '적용'과 같은 결과가 아니다 — 소스가 다르다.",
    cubeNote: "Input: Sony S-Log3 / S-Gamut3.Cine",
    transfer: {
      id: "slog3",
      decode: colorspace.slog3Decode,
      // 코드 1.0이 만드는 로그노광. 화이트포인트 정규화 기준이라 반드시 함께 준다.
      hWhite: Math.log10(colorspace.slog3Decode(1) / 0.18),
    },
    encode: colorspace.slog3Encode,
    toProPhoto: colorspace.SGAMUT3CINE_TO_PROPHOTO,
  },
];

const INPUT_BY_ID = new Map(INPUTS.map((i) => [i.id, i]));

function inputById(id) {
  return INPUT_BY_ID.get(id) || INPUTS[0];
}

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

/**
 * 입력 축의 **원색만** 옮긴다. 톤 축(전달함수)은 그대로다.
 *
 * `convertSpace`와 다르다 — 저쪽은 입력·출력 인코딩을 함께 바꾸는 대칭 변환이고,
 * 이쪽은 이미 그 전달함수로 구워진 LUT의 **입력 원색**만 바꾼다.
 *
 *     M(y) = L( encode( T · decode(y) ) )
 *
 * ⚠️ 행렬이 채널을 섞으므로 축마다 1차원 표를 만들 수 없다. 격자점마다 3채널을
 * 함께 변환해야 한다(`convertSpace`의 `coord[]` 최적화가 여기서는 안 통한다).
 *
 * ⚠️ 색역 밖은 잘린다. S-Gamut3.Cine의 청색 원색은 y가 음수라 ProPhoto로 옮기면
 * 음의 선형값이 나오고, `lut.sample`이 격자 범위로 조인다. 실제 촬영본이 거기까지
 * 가는 일은 드물지만 합성 차트로 시험하면 보인다.
 */
function convertPrimaries(table, size, matrix, decode, encode) {
  const out = new Float32Array(table.length);
  const tmp = [0, 0, 0];
  const d = size - 1;
  const m = matrix;
  let p = 0;

  for (let bi = 0; bi < size; bi++) {
    const lb = decode(bi / d);
    for (let gi = 0; gi < size; gi++) {
      const lg = decode(gi / d);
      for (let ri = 0; ri < size; ri++) {
        const lr = decode(ri / d);
        const cr = encode(m[0][0] * lr + m[0][1] * lg + m[0][2] * lb);
        const cg = encode(m[1][0] * lr + m[1][1] * lg + m[1][2] * lb);
        const cb = encode(m[2][0] * lr + m[2][1] * lg + m[2][2] * lb);
        lut.sample(table, size, cr, cg, cb, tmp);
        out[p++] = tmp[0];
        out[p++] = tmp[1];
        out[p++] = tmp[2];
      }
    }
  }
  return out;
}

/**
 * 출력 값만 다른 인코딩으로 옮긴다. **입력 축은 건드리지 않는다.**
 *
 * 비대칭 LUT(로그 입력 → 표시 출력)에서 쓴다. 입력 축은 이미 소스 인코딩으로
 * 맞춰져 있으므로 재격자하면 안 되고, 나오는 값만 바꾸면 된다.
 */
function reencodeOutput(table, from, to) {
  if (from.id === to.id) return table;
  const out = new Float32Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = to.encode(from.decode(table[i]));
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
  const input = inputById(o.input);
  if (input.transfer) parts.push(input.id);
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
 * @param {object} [opts]  { size, space, input }
 */
function build(params, opts) {
  const o = opts || {};
  const size = SIZES.includes(o.size) ? o.size : SIZES[0];
  const space = spaceById(o.space);

  // 필름이 꺼져 있어도 그레이딩만으로 유효한 LUT이 된다. 막을 것은 "필름이
  // 꺼진 상태"가 아니라 **항등 LUT**이다 — 내보내 봐야 아무 일도 하지 않는다.
  if (!film.hasEffect(params)) {
    throw new Error("필름과 색 조정이 모두 꺼져 있어 내보낼 것이 없습니다.");
  }

  // buildForParams가 유제 → 스캐너 → 사용자 조정까지 다 굽는다.
  // 즉 내보낸 .cube는 "현재 문서에 적용"과 같은 결과를 낸다.
  const input = inputById(o.input);

  if (!input.transfer) {
    // 대칭 LUT — 입력·출력 인코딩이 같다. 지금까지의 동작 그대로.
    const native = film.buildForParams(params, size);
    const table = convertSpace(native, size, SPACES[0], space);
    return lut.toCube(table, size, title(params, opts), space.cubeNote);
  }

  // 비대칭 LUT — 로그 입력 → 표시 출력.
  //
  // 1. 그 전달함수로 **처음부터 굽는다**. 재격자로는 정의역이 안 늘어난다(위 INPUTS 주석).
  // 2. 입력 원색을 소스 색역 → ProPhoto로 옮긴다. 톤 축은 그대로.
  // 3. 출력 값만 선택한 색공간 인코딩으로.
  let table = film.buildForParams(params, size, { input: input.transfer });
  if (input.toProPhoto) {
    table = convertPrimaries(table, size, input.toProPhoto, input.transfer.decode, input.encode);
  }
  table = reencodeOutput(table, SPACES[0], space);

  const note = `${input.cubeNote} → output: ${space.cubeNote}`;
  return lut.toCube(table, size, title(params, opts), note);
}


module.exports = {
  SPACES,
  INPUTS,
  inputById,
  SIZES,
  spaceById,
  convertSpace,
  suggestName,
  title,
  build,

};
