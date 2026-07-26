/**
 * ACR Look 프로파일(.xmp) 직접 생성.
 *
 * Camera Raw의 New Profile 대화상자를 거치지 않고 플러그인이 프로파일 파일을 바로
 * 쓴다. 대화상자 경로는 프로파일 하나당 클릭 예닐곱 번이고 배치가 불가능하다
 * (Adobe도 배치 도구를 제공하지 않는다). 필름 8종 × 스캐너 2종이면 16번을 손으로
 * 반복해야 하고, 엔진을 손볼 때마다 처음부터 다시 해야 한다.
 *
 * 포맷은 v2plan 7.5에 규명해 뒀다. 요약:
 *
 *   binary  = <4I: 1,1,3,N> + N³×3 uint16 LE + <3I: 색공간> + <2d: 0.0, 2.0>
 *   payload = <I: len(binary)> + zlib(binary)
 *   text    = AdobeBase85(payload)
 *   ID      = md5(binary) 대문자
 *
 * ── 왜 .cube 경유보다 나은가 ────────────────────────────────────────────
 *
 * 품질에서도 낫다. ACR은 어떤 크기의 .cube를 넣어도 **32³으로 리샘플**해서
 * 저장한다. 실측에서 우리 65³ .cube로 만든 프로파일의 32³ 테이블은 우리 엔진의
 * 32³ 빌드와 코너 8점만 일치했다 — 65격자와 32격자가 겹치는 지점이 양 끝뿐이라
 * 나머지는 전부 보간값이기 때문이다.
 *
 *   .cube 경유:  엔진 → 65³ → ACR 리샘플 → 32³     (보간 2회)
 *   직접 생성:   엔진 → 32³                        (보간 0회)
 */

const film = require("../color/film");
const films = require("../color/films");
const scanner = require("../color/scanner");
const codec = require("./xmpcodec");

/**
 * ACR이 프로파일 안에 담는 격자 크기. 더 크게 줘도 32로 줄어든다.
 * 우리가 처음부터 32로 구우면 리샘플이 일어나지 않는다.
 */
const LUT_SIZE = 32;

/** Profile Browser에서 한 덩어리로 묶이는 이름. */
const GROUP = "FilmSim";

/**
 * 꼬리 12바이트에 실리는 색공간 식별자.
 *
 * ⚠️ **실측한 두 조합만 있다.** New Profile 대화상자에서 색공간만 바꿔 프로파일을
 * 두 벌 만들어 비교해 얻은 값이다. 세 정수 중 첫째가 색공간으로 보이지만 둘째가
 * 왜 같이 바뀌는지는 모른다. Adobe RGB / P3는 관측한 적이 없으므로 넣지 않는다 —
 * 추측한 값을 넣으면 조용히 틀린 프로파일이 나온다.
 *
 * 같은 .cube로 만든 두 프로파일의 **샘플 데이터는 완전히 동일**했다. 즉 ACR은
 * 색공간으로 테이블을 변환하지 않고 메타데이터로만 기록하고 렌더 시점에 해석한다.
 */
const SPACES = {
  prophoto: { tail: [2, 2, 0], displayName: "ProPhoto RGB" },
  srgb: { tail: [0, 1, 0], displayName: "sRGB" },
};

/**
 * ACR 버전 문자열. 실측한 파일에서 그대로 가져왔다 — 이 값으로 만든 프로파일이
 * 동작하는 것을 확인했다. 추측한 값을 넣을 자리가 아니다.
 */
const CRS_VERSION = "18.3.2";
const PROCESS_VERSION = "15.4";

/**
 * 저장용 uint16 — **값이 아니라 항등과의 차이(residual)를 담는다.**
 *
 *     stored = round((v − i/(N−1)) × 65536) mod 65536
 *
 * `v`는 그 격자점의 출력(0~1), `i`는 **그 채널에 대응하는 축의 격자 인덱스**다.
 * R은 r, G는 g, B는 b를 쓴다. 항등 LUT이면 전부 0이 된다.
 *
 * 왜 이렇게 하는가 — 잔차는 작고 매끄러워서 zlib이 훨씬 잘 줄인다. ACR이 만든
 * 테이블의 압축률이 우리 원본보다 좋았던 이유가 이것이다.
 *
 * ── 이걸 놓쳐서 첫 판이 깨졌다 ──────────────────────────────────────────
 *
 * 처음에 값을 그대로 넣었더니 Lightroom에서 **밝은 영역이 파랑·자홍으로 뭉개졌다.**
 * 원인 추적이 늦어진 이유가 있다. 검증을 **코너 8점으로 했는데, 하필 그 8점이
 * 잔차 인코딩에서도 값 그대로일 때와 같은 수를 낸다.** i=0이면 항등항이 0이고,
 * i=N−1이면 65536 ≡ 0이기 때문이다. 그래서 6/8 일치를 보고 포맷이 맞다고 판단했다.
 *
 * 게다가 코너는 **축 순열에도 불변**이라 축 순서 검증에도 쓸모가 없었다.
 * 축을 따라 훑는 검사를 했으면 첫 판에 드러났을 것이다.
 *
 * 전체 평균 오차를 재보고 나서야(63.9%) 코너 일치가 무의미하다는 것이 드러났다.
 * **일치를 확인할 때는 그 검사가 틀린 가설도 통과시키는지 먼저 따져야 한다.**
 */
function residual(v, i, denom) {
  let d = Math.round((v - i / denom) * 65536);
  // ±65536은 감기면 0이 되어 정반대 값으로 복호된다.
  //   v=1.0, i=0        → +65536 → 0  → 흰색이 검정으로
  //   v=0.0, i=N−1      → −65536 → 0  → 검정이 흰색으로
  // 65535로 잘라내면 0.99998이라 렌더 차이가 없고 이 함정만 피한다.
  if (d >= 65536) d = 65535;
  else if (d <= -65536) d = -65535;
  return d & 0xffff; // 음수는 2의 보수로 감긴다 — 의도된 동작이다
}

/**
 * 엔진 LUT을 프로파일 바이너리로 직렬화한다.
 *
 * **축 순서가 뒤집힌다.** `.cube`(와 우리 엔진)는 R이 가장 빨리 변하지만
 * (`(b·N+g)·N+r`), 프로파일은 **B가 가장 빨리 변하고 R이 가장 느리다**
 * (`r·N²+g·N+b`). 그대로 옮기면 적·청이 뒤바뀐 LUT이 된다.
 *
 * @param {Float32Array} table  엔진이 구운 LUT (.cube 순서)
 * @param {number[]} tail       색공간 식별자 3정수
 */
function buildBinary(table, tail) {
  const N = LUT_SIZE;
  const samples = N * N * N * 3;
  const buf = new ArrayBuffer(16 + samples * 2 + 28);
  const dv = new DataView(buf);

  // 헤더 — (버전?, 버전?, 차원 수, 격자 크기)
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, 3, true);
  dv.setUint32(12, N, true);

  const denom = N - 1;
  let p = 16;
  for (let r = 0; r < N; r++) {
    for (let g = 0; g < N; g++) {
      for (let b = 0; b < N; b++) {
        const src = ((b * N + g) * N + r) * 3; // 엔진(.cube) 순서에서 읽는다
        // 채널마다 자기 축의 인덱스를 항등 기준으로 쓴다
        dv.setUint16(p, residual(table[src], r, denom), true);
        dv.setUint16(p + 2, residual(table[src + 1], g, denom), true);
        dv.setUint16(p + 4, residual(table[src + 2], b, denom), true);
        p += 6;
      }
    }
  }

  dv.setUint32(p, tail[0], true);
  dv.setUint32(p + 4, tail[1], true);
  dv.setUint32(p + 8, tail[2], true);
  dv.setFloat64(p + 12, 0.0, true);
  dv.setFloat64(p + 20, 2.0, true);

  return new Uint8Array(buf);
}

/** XML 속성값에 그대로 넣을 수 있게. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 프로파일 UUID. 난수를 쓰지 않는다 — 같은 입력이면 같은 파일이 나와야 두 번
 * 내보냈을 때 diff가 깨끗하고, 재생성해도 Lightroom이 같은 프로파일로 인식한다.
 */
function uuidFor(name, tableId) {
  return codec.md5(codec.utf8(`FilmSim|${name}|${tableId}`));
}

const TEMPLATE = (f) => `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Look"
   crs:Cluster=""
   crs:UUID="${f.uuid}"
   crs:SupportsAmount="True"
   crs:SupportsColor="True"
   crs:SupportsMonochrome="True"
   crs:SupportsHighDynamicRange="True"
   crs:SupportsNormalDynamicRange="True"
   crs:SupportsSceneReferred="True"
   crs:SupportsOutputReferred="True"
   crs:RequiresRGBTables="False"
   crs:ShowInPresets="True"
   crs:ShowInQuickActions="False"
   crs:CameraModelRestriction=""
   crs:Copyright=""
   crs:ContactInfo=""
   crs:Version="${CRS_VERSION}"
   crs:ProcessVersion="${PROCESS_VERSION}"
   crs:ConvertToGrayscale="False"
   crs:RGBTable="${f.id}"
   crs:Table_${f.id}="${f.payload}"
   crs:HasSettings="True">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(f.name)}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:ShortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(f.shortName)}</rdf:li>
    </rdf:Alt>
   </crs:ShortName>
   <crs:SortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(f.sortName)}</rdf:li>
    </rdf:Alt>
   </crs:SortName>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(GROUP)}</rdf:li>
    </rdf:Alt>
   </crs:Group>
   <crs:Description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(f.description)}</rdf:li>
    </rdf:Alt>
   </crs:Description>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

/** Profile Browser에 뜨는 이름. 필름 + 스캐너 + (노광). */
function profileName(params) {
  const f = films.byId(params.film.id);
  const sc = scanner.byId(params.film.scanner);
  const ev = params.film.exposure || 0;
  let n = f.displayName;
  if (sc.id !== "none") n += ` · ${sc.displayName}`;
  if (ev) n += ` ${ev > 0 ? "+" : ""}${ev}EV`;
  return n;
}

/**
 * 파일 이름. 표시 이름과 달리 **ASCII만 남긴다.**
 *
 * 표시 이름에는 가운뎃점(·)을 쓰지만 파일 이름에 넣지 않는다. 파일 시스템·
 * 압축 도구·Lightroom 사이를 오갈 때 인코딩이 어긋나면 조용히 깨지는데, 그 위험을
 * 파일 이름에서까지 감수할 이유가 없다.
 */
function fileNameFor(params) {
  return (
    `FilmSim - ${profileName(params)}`
      .replace(/·/g, "-")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim() + ".xmp"
  );
}

/**
 * 현재 파라미터로 프로파일 XMP 텍스트를 만든다.
 * @param {object} params
 * @param {object} [opts]  { space: "prophoto" | "srgb" }
 */
function buildXmp(params, opts) {
  const o = opts || {};
  const space = SPACES[o.space] || SPACES.prophoto;

  // 필름이 꺼져 있어도 그레이딩만으로 유효한 프로파일이 된다.
  if (!film.hasEffect(params)) {
    throw new Error("필름과 색 조정이 모두 꺼져 있어 내보낼 것이 없습니다.");
  }

  // buildForParams가 유제 → 스캐너 → 사용자 조정까지 굽는다.
  // 즉 프로파일은 "현재 문서에 적용"과 같은 결과를 낸다.
  const table = film.buildForParams(params, LUT_SIZE);

  const binary = buildBinary(table, space.tail);
  const id = codec.md5(binary);

  const z = codec.zlibStored(binary);
  const payload = new Uint8Array(4 + z.length);
  new DataView(payload.buffer).setUint32(0, binary.length, true);
  payload.set(z, 4);

  const name = profileName(params);
  const f = films.byId(params.film.id);
  const note = (f.source && f.source.note) || "";

  return TEMPLATE({
    uuid: uuidFor(name, id),
    id,
    payload: codec.base85(payload),
    name,
    shortName: GROUP,
    sortName: name,
    description: note ? `FilmSim — ${note}` : "FilmSim",
  });
}

/** 기본 배포 세트. 노광은 ACR 슬라이더로 조절하면 되므로 0EV만 낸다. */
function defaultSet(params) {
  const out = [];
  for (const f of films.all()) {
    for (const sc of scanner.all()) {
      if (sc.id === "none") continue; // 유제만인 룩은 배포용으로 의미가 약하다
      const p = JSON.parse(JSON.stringify(params));
      p.film.enabled = true;
      p.film.id = f.id;
      p.film.scanner = sc.id;
      p.film.exposure = 0;
      out.push(p);
    }
  }
  return out;
}



module.exports = {
  LUT_SIZE,
  GROUP,
  SPACES,
  buildBinary,
  buildXmp,
  profileName,
  fileNameFor,
  defaultSet,


};
