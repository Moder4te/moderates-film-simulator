# RAW 플랫 현상부 — LibRaw를 WebAssembly로

`filmsim_raw.cpp`는 [LibRaw](https://www.libraw.org/)를 감싸 RAW·DNG를 **톤 커브 없이**
푼다(카메라 화이트밸런스 · 자동 밝기 없음 · 감마 1 · ProPhoto · 16bit —
`tools/decode-raw.py`와 같은 인자). 빌드 결과가 `apps/studio/vendor/filmsim-raw.wasm`이고
Studio(브라우저 · Windows · Android)가 그 하나를 쓴다.

| | |
|---|---|
| 다시 빌드 | `tools/build-raw-wasm.sh` — emscripten(`em++`)과 LibRaw 소스가 필요하다 |
| 불러오는 쪽 | `core/io/rawdecoder.js` |
| 검사 | `node tools/check-studio.js`(합성 DNG — 선형성·중성) · `python tools/check-raw.py <RAW>`(rawpy와 화소 대조) |

`.wasm`은 **커밋한다.** Studio 빌드가 노드만으로 돌게 하려는 것이다. 이 폴더나 LibRaw 판을
고쳤으면 다시 빌드해 함께 커밋하고, `check-raw.py`로 rawpy와 값이 같은지 확인한다.

## 못 여는 것

- **Deflate(ZIP)로 압축한 DNG** — zlib을 넣지 않았다. 무압축·무손실 JPEG(가장 흔한 형태) DNG는 된다
- **손실 JPEG · JPEG XL로 압축한 DNG** — libjpeg·libjxl을 넣지 않았다(최근 폰의 일부 DNG)
- LibRaw 0.22.2가 모르는 카메라

## 라이선스

LibRaw는 **LGPL 2.1 / CDDL 1.0 이중 라이선스**이고 이 프로젝트는 **CDDL 1.0** 조건으로 쓴다.

- LibRaw — Copyright © 2008–2025 LibRaw LLC. 소스: <https://github.com/LibRaw/LibRaw> 태그 `0.22.2`
  (커밋 `b93f6e45c194f5df9b02a43b1af9a54b4f41f33f`). **고치지 않고** 그대로 컴파일했다
- CDDL 1.0 전문: <https://opensource.org/license/cddl-1-0> (LibRaw 소스의 `LICENSE.CDDL`)
- `filmsim-raw.wasm`은 LibRaw(CDDL)와 이 폴더의 `filmsim_raw.cpp`(이 저장소의 라이선스)를 함께
  링크한 것이다. CDDL은 파일 단위 라이선스라 LibRaw의 파일들에만 걸린다

이 저장소 본체의 라이선스(PolyForm Noncommercial 1.0.0, `LICENSE.md`)는 LibRaw에 적용되지 않는다.
