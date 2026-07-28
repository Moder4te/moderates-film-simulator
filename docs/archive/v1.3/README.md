> ## ⚠️ 아카이브 — v1.3 단일 플러그인 원본
>
> v2에서 **엔진(색) · 마감(광학)** 두 플러그인으로 갈라지기 전의 마지막 단일 플러그인이다.
> 어디서도 참조되지 않는 죽은 트리이고, 아래 설치·개발 안내는 **현행이 아니다**.
> 같은 내용이 `v1.3.0` 태그에 저장소 루트 기준으로 그대로 남아 있다
> (`git show v1.3.0:src/batch.js`).
>
> 현행은 [`../../../README.md`](../../../README.md) ·
> [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) · [`../../STATUS.md`](../../STATUS.md) 참조.
>
> **여기를 고치지 말 것.** v1.3의 `src/batch.js`는 `apps/finish/src/batch.js`와 한때
> 바이트 단위로 동일했고, 그래서 한쪽만 고쳐지는 사고의 씨앗이었다. 현행 수정은
> `apps/` 쪽에만 한다.

# Moderate's Film Simulator — Photoshop UXP 플러그인

디지털 사진에 아날로그 필름의 광학적·화학적 특성을 재현하는 포토샵 플러그인.
기획 문서는 [SPEC.md](./SPEC.md) 참고.

## 설치 (일반 사용자 — 개발자 툴 불필요)

1. Photoshop 2023 (v24) 이상을 설치한다.
2. [최신 `.ccx` 다운로드](https://github.com/Moder4te/moderates-film-simulator/releases/latest/download/com.filmsim.photoshop_PS.ccx)
   — 항상 최신 릴리스의 `com.filmsim.photoshop_PS.ccx`를 곧바로 내려받는다.
   ([전체 릴리스 목록](https://github.com/Moder4te/moderates-film-simulator/releases))
3. `.ccx`를 더블클릭한다. Adobe 플러그인 설치 관리자(Creative Cloud와 함께 설치됨)가
   설치를 진행한다. "확인되지 않은 게시자" 경고가 나오면 설치를 허용한다(자체 서명).
4. Photoshop을 재시작한다.
5. `플러그인` 메뉴에 **Film Simulation**(메인)과 **Film Sim 미리보기**(별도 패널)가
   나타난다. 미리보기 패널을 열어 메인 옆에 도킹하면 된다.

설치형(.ccx)은 UXP Developer Tool이 필요 없고 Photoshop 재시작 후에도 유지된다.

## 개발 (소스에서 로드)

1. [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/devtool/) 설치
2. Photoshop 실행 (2023 / v24 이상)
3. UDT에서 **Add Plugin** → 이 저장소의 `manifest.json` 선택 → **Load**
4. 코드 수정 후 UDT **Reload**로 반영

패키징(.ccx 생성): `uxp plugin package --outputPath dist`
(플러그인·패널 아이콘이 manifest에 있어야 하며, `icons/`에 포함되어 있다)

## 파일 구조

```
manifest.json          플러그인 매니페스트 (UXP manifest v5, 패널 2개)
index.html             두 패널 UI(#mainPanel · #previewPanel) 마크업 + 스타일
src/
  main.js              부트스트랩, 멀티패널 setup, UI ↔ 모델 바인딩, 액션 배선
  params.js            파라미터 스키마, 기본값, 구버전 프리셋 마이그레이션
  ps.js                batchPlay 래퍼 및 저수준 액션 헬퍼
  grading.js           CMYK 그레이딩 (Curves + Crosstalk + Selective Color)
  halation.js          할레이션 (하이라이트 추출 → 채널별 블러 → Screen)
  grain.js             명암별 차등 그레인 (노이즈 + Blend If 존 마스킹)
  simulate.js          그레이딩 JS 근사 시뮬레이션 (팔레트·컬러휠 미리보기용, v2)
  colorwheel.js        컬러휠 색 이동 시각화 + 마커 편집 (DOM, translate 전용, v2)
  photoanalysis.js     사진 색역 분석 → 컬러휠 대표색 추출 (v1.2)
  cslider.js           커스텀 슬라이더 (div + PointerEvent, v2)
  preview.js           미리보기 패널 렌더 (imaging → grading 픽셀 → img, v2)
  pipeline.js          처리 순서 고정 및 히스토리 병합
  presets.js           프리셋 저장/불러오기/가져오기/내보내기
  batch.js             폴더 배치 적용
```

## 핵심 구현 결정

**CMYK 그레이딩 — 문서 모드를 바꾸지 않는다**
`Selective Color` 조정 레이어는 RGB 문서에서도 내부적으로 CMYK 좌표계로 동작한다.
이를 그대로 엔진으로 쓴다. 문서를 실제 CMYK 모드로 변환하면 색역 손실이 크다.

**크로스토크 — Channel Mixer가 곧 RGB 3×3 매트릭스다** (v2)
필름 유제층 간 색 유출을 Channel Mixer 조정 레이어로 구현한다. Channel Mixer의
각 출력 채널(`red`/`grain`/`blue`, green이 아니라 grain)은 소스 채널 가중치를 담는
`channelMatrix`이며, 이것이 정확히 3×3 매트릭스다. UI는 대칭 강도 슬라이더 하나만
노출하고 `crosstalkMatrixFromAmount`로 매트릭스를 파생한다. 비대칭 미세조정은
프리셋 JSON의 `grading.crosstalk.matrix`를 직접 편집하면 된다.
크로스토크는 Selective Color보다 아래(먼저) 적용되어야 유제 물리에 가깝다.

**미리보기 — 패널 내 실제 사진 렌더 (별도 패널)** (v2)
Photoshop에 문서를 열지 않고, 활성 문서를 축소해 읽어(getPixels) grading을 픽셀마다
적용한 뒤 base64 JPEG로 인코딩해 `<img>`에 그린다. **별도 UXP 패널**(`filmsim.preview`)이라
사용자가 메인 패널 옆에 도킹할 수 있다. 두 패널은 같은 JS 컨텍스트를 공유하므로
main.js가 미리보기 패널의 `<img>`를 그대로 갱신한다(패널 간 통신 불필요).

- 검증된 imaging 파이프라인: `getPixels(targetSize)` → `getData(RGBA)` → RGB 3채널
  추출(**alpha 있으면 JPEG 인코딩 불가**) → `createImageDataFromBuffer` →
  `encodeImageData(base64)` → `img` data URI.
- 성능(측정): 280px 썸네일 grading 픽셀순회 ~85ms + 나머지 ~5ms = ~90ms. 조작이
  멈춘 뒤(디바운스 250ms) 한 번 렌더한다. 조작 중 실시간 피드백은 팔레트·컬러휠
  시뮬레이션이 담당한다.
- 범위: **grading(색)만** 반영. halation/grain은 공간 연산이라 픽셀 JS로 무겁고
  근사가 부정확해 제외 — 실제 결과는 [적용]으로 확인한다.
- 미리보기 프레임(`pv-frame`)이 패널을 꽉 채운 고정 크기라, img src 교체 순간에도
  레이아웃이 흔들리지 않는다.
- 한계: 활성 문서를 그대로 읽으므로, 이미 [적용]한 문서면 그 위에 grading이 이중으로
  얹혀 보인다. 적용 전 상태에서 보는 것을 전제로 한다. — `preview.js`

**팔레트 미리보기 — 패널 내 JS 시뮬레이션** (v2)
대표 색 15개(스킨 3단계·하늘·잎·원색·보색·무채색)에 grading을 JS로 근사 적용해
스와치로 보여준다. 각 스와치는 대각선으로 원본(좌상)과 적용색(우하)을 나눈다.
Photoshop 왕복이 없어 슬라이더를 움직이는 즉시 갱신된다.
크로스토크는 매트릭스 곱이라 실제와 사실상 동일하고, curve/selective color는
방향성만 맞는 근사다(Selective Color 내부 알고리즘이 비공개). 정확한 결과는
미리보기 패널(실제 사진)이나 실제 적용으로 확인한다. — `simulate.js`

**컬러휠 — DOM + translate 전용 시각화 + 직접 편집** (v2)
색조 원반 위에 대표 색을 얹어, 각 색이 그레이딩·크로스토크로 어디로 이동하는지
(○ 원본 → ● 적용 + 점선 경로) 실시간으로 보여준다. 크로스토크 강도를 올리면
색들이 서로 끌려가는 벡터가 한눈에 보여, 등방 강도 슬라이더보다 직관적이다.
UXP 렌더링 제약(canvas 블랙아웃, rotate 미적용 — 아래 함정 참고) 때문에
canvas도 SVG도 rotate도 못 쓰고, 최종적으로 순수 DOM + translate로만 구현했다.
색상환은 원주에 색점 72개, 마커·경로는 translate로 배치한다. — `colorwheel.js`

편집도 컬러휠에서 직접 한다:
- **마커 드래그**: 적용점(●)을 끌면 그 색이 속한 Selective Color 색역을 자동 판정해
  색역 칩을 전환하고, 드래그 방향(색조)의 최대채도색을 기준으로 CMY를 조절한다.
  조절 강도는 드래그 거리로 키운다 — 휠 가장자리에서 1, **밖으로 더 끌면 증폭**
  (`sat` 상한 2.5 × 게인 1.4). 또 밝기에 하한(0.55)을 둬 **어두운 색도 넓게** 조절되게
  한다(원본 밝기를 그대로 쓰면 어두운 색은 도달 범위가 −1~15로 극히 좁았다 →
  −100~52로 개선). 원본색이 이미 포화한 방향(예: 빨강을 더 빨갛게)은 R>255가 불가라
  자연히 제한되며, 그런 극단 보정은 슬라이더로 직접 한다. `handleMarkerDrag`.
- **무채색 미니휠**: whites/neutrals/blacks는 채도 0이라 큰 휠 중심에 뭉쳐 못 고른다.
  [컬러]/[무채색] 탭으로 나누고, 무채색은 톤별 전용 미니휠 3개에서 각각 드래그한다.
  큰 휠에는 유채 6색역만 얹는다(마커 index = 색역). `buildMini` / `handleAchromaDrag`.
- **더블탭 리셋**: 마커·미니휠·슬라이더 모두 더블탭(300ms 내 재탭)하면 기본값으로
  되돌린다. UXP `dblclick`이 불안정해 pointerdown 간격으로 직접 감지한다.

**컬러휠 마커 = 실제 사진의 대표색** (v1.2)
고정 대표색 대신, 불러온 사진을 분석해 색역별 대표색을 마커로 얹는다. 컬러휠·색역
편집 구조와 1:1 대응하고 필름 그레이딩(색역별 발색)과 직결된다.
- 추출: 사진을 200px로 읽어(`imaging.getPixels`) 픽셀 1회 순회. 각 픽셀을 색역으로
  분류해 **채도 가중 평균**으로 대표색을 낸다(k-means 같은 반복 없이 가볍다). 채도
  가중이라 그 색역에 애매하게 걸친 저채도 픽셀이 대표를 회색으로 흐리지 않는다.
- 메인 휠: 유채 6색역 대표 1개씩. **세부 휠**: 선택 색역을 밝기 4구간으로 세분한
  대표들이 grading으로 어디로 이동하는지 보여준다(색역 안을 파고듦).
- 문서 전환 시 재분석(`select`/`open` 알림 + 문서 id로 걸러 실제 전환만). 파라미터
  변경 시엔 원본색이 고정이라 재분석 없이 grading만 재적용. — `photoanalysis.js`

**색역 선택 — 커스텀 칩** (v2)
Selective Color 색역 선택을 `sp-picker`로 했으나, UXP에서 `sp-picker.value`가
`undefined`라 프로그램 제어가 안 됐다(색역이 항상 reds에 묶임). div 칩 9개 +
JS 상태 변수(`currentRangeVal`)로 교체해, 수동 선택과 마커 드래그 자동 선택을
모두 확실히 제어한다. — `main.js`

**슬라이더 — 커스텀 div + PointerEvent** (v2)
Spectrum `sp-slider`는 native UI로 매핑되어 드래그가 느리고(초당 ~11 input), 매
input마다 도는 시각화 갱신과 겹쳐 심하게 버벅였다. 순수 `input[type=range]`는
UXP가 렌더하지 않는다(0×0). 그래서 div + PointerEvent로 직접 만들었다.
드래그 성능의 핵심: 트랙 위치를 pointerdown에서 1회만 캐시(매 move의 reflow 제거),
pointermove는 좌표만 저장하고 rAF로 프레임당 1회 반영. — `cslider.js`

**재적용은 덮어쓴다 + 결과를 그룹으로 묶는다**
`run`은 끝에 결과 레이어들을 하나의 `FilmSim` 그룹으로 묶는다(레이어 패널이 깔끔하고,
그룹째 켜고 끄거나 불투명도로 전체 강도를 조절할 수 있다). 시작 시에는 이름이
`FilmSim`으로 시작하는 이전 레이어·그룹을 모두 지워, 같은 문서에 여러 번 적용해도
쌓이지 않고 덮어쓴다(검증: 재적용해도 FilmSim 그룹 children 2 유지, 배경 보존).
단일 적용·배치 공통. — `pipeline.js`

주의(발견): 그룹의 `layer.delete()`는 그룹만 해제(ungroup)하고 안의 레이어를 최상위로
꺼낸다(레이어 자체는 안 지워짐). 그래서 삭제는 FilmSim 이름 레이어가 없어질 때까지
반복해야 한다 — 첫 회에 그룹이 풀리고, 다음 회에 개별 레이어가 실제 삭제된다.

**그레인 존 마스킹 — Blend If를 쓴다**
루미넌스 마스크 채널을 만드는 대신 레이어의 Blend If(underlying layer) 범위를 지정한다.
채널을 생성하지 않아 가볍고, 페더링이 공짜로 따라오며, 완전히 비파괴적이다.

**할레이션 — 채널별 블러 반경이 핵심**
R/G/B에 동일 반경을 쓰면 그냥 글로우가 된다. 레드를 가장 넓게 퍼뜨려야
할레이션으로 읽힌다. 기본 배율 R 1.0 / G 0.55 / B 0.3.

**파이프라인 순서는 고정이다**
그레이딩 → 할레이션 → 그레인. 그레인을 먼저 넣으면 이후 색 보정에 노이즈가
함께 증폭되어 부자연스러워진다.

**Photoshop 채널 열거자 주의**
ActionDescriptor에서 green 채널의 값은 `"grain"`이다. `"green"`이 아니다.
`grading.js`와 `halation.js` 양쪽에 해당한다.

## UXP 함정 (실제로 부딪힌 것들)

**개발자 모드는 Photoshop 시작 시점에 읽힌다**
Photoshop 실행 중에 개발자 모드를 켜면 `plugin validate`는 통과하지만 `plugin load`가
`Devtools: Failed to load the devtools plugin.` 한 줄만 남기고 실패한다. 사유가 전혀
나오지 않아 오진하기 쉽다. 반드시 켠 뒤 Photoshop을 재시작할 것.

**require는 스크립트 위치가 아니라 플러그인 루트 기준으로 해석된다**
`<script src="./src/main.js">`로 로드된 진입 모듈에서 `require("./params")`는
`Module not found: "./params". Parent module folder was: "./"`로 실패한다.
진입 모듈에서만 `require("./src/params")`처럼 루트 기준 경로를 쓴다.
그 아래 모듈끼리의 상대 require는 각자 폴더 기준으로 정상 해석된다.

**UXP DOM은 표준 DOM의 부분집합이다**
- `childElementCount`가 없다. `children.length`를 쓸 것.
- `dispatchEvent(new Event("input"))`은 `Cannot read properties of undefined (reading 'detail')`로
  죽는다. Spectrum 컴포넌트에 스크립트로 이벤트를 넣을 수 없다고 보는 편이 안전하다.
- `element.click()` 프로그램 호출이 일반 div의 click 핸들러를 발화하지 않는다.
  클릭성 상호작용은 `pointerdown`으로 바인딩하는 편이 안전하다(슬라이더·칩·탭 전부).
- `for (const x of nodeList)`의 `const` 바인딩이 클로저에 공유될 수 있다(클릭 핸들러가
  엉뚱한 요소를 참조). `forEach`를 쓰고 클릭 대상은 `event.currentTarget`에서 읽을 것.
- `className` 쓰기·`dataset` 읽기·`querySelectorAll`·`getBoundingClientRect`는 정상.

**`sp-picker`는 프로그램 제어(`.value`)가 안 된다**
`sp-picker.value`가 `undefined`라 코드로 선택 항목을 바꾸거나 읽을 수 없다. 값에
연동되는 로직(여기선 색역 선택)이 조용히 기본값에 묶인다. 드롭다운을 코드로
제어해야 하면 커스텀 칩/버튼 + JS 상태 변수로 대체할 것.

**멀티패널 — `show(event)`의 event가 곧 패널 노드다**
`entrypoints.setup({ panels })`로 패널을 여러 개 둘 수 있고, 모든 패널이 **같은 JS
컨텍스트를 공유**한다(전역·모듈 상태로 통신, 별도 IPC 불필요). 단 `show(event)`에서
event는 `event.node`가 아니라 **event 자체가 패널 컨테이너 노드**다(`event.appendChild`).
메인 패널의 event는 `BODY`, 추가 패널의 event는 `UXP-PANEL` 노드. body에 콘텐츠 div를
두고 각 패널 show에서 자기 div를 event로 옮기면 분리된다. manifest에 패널 entrypoint
추가는 `plugin reload`로 반영 안 되니 `unload` 후 `load`.

**imaging 인코딩은 alpha(RGBA)를 JPEG로 못 만든다**
`imaging.encodeImageData`는 기본 JPEG인데, `getPixels`가 준 RGBA(4채널)를 그대로
넣으면 "Image data with alpha cannot be encoded as jpeg"로 실패한다(`format:"png"`도
무시됨). RGB 3채널만 추출해 `createImageDataFromBuffer(..., components:3, colorSpace:"RGB")`로
새 ImageData를 만든 뒤 인코딩할 것. `base64:true`면 data URI에 바로 쓸 문자열을 준다.

**패널 세로 스크롤은 `html/body` 높이를 명시해야 생긴다**
`body`에 `overflow-y:auto`만 줘도 콘텐츠가 넘칠 때 스크롤바가 안 생긴다.
`html, body { height: 100%; }`를 함께 줘야 스크롤이 동작한다.
(검증: 콘텐츠 scrollHeight 1789 > 뷰포트 clientHeight 1442, `scrollable: true`)

**CSS Grid와 `aspect-ratio`를 지원하지 않는다**
`display:grid` 컨테이너와 `aspect-ratio` 요소는 0×0으로 접혀 화면에서 사라진다.
`getComputedStyle`은 `display:grid`를 보고하지만 실제 레이아웃은 되지 않는다.
flexbox(`display:flex; flex-wrap:wrap; gap`)와 고정 높이를 쓸 것.
팔레트 그리드가 이 문제로 처음에 통째로 안 보였다. (렌더 크기 0×0으로 확인)

**렌더링/레이아웃 미지원 목록 (실측)**
컬러휠·슬라이더를 만들며 하나씩 부딪혀 확인한 것들. `getComputedStyle`은 값을
그대로 되돌려주지만 **실제 렌더는 안 되는** 경우가 많아, 반드시 `getBoundingClientRect`
같은 실측으로 확인해야 한다.

| 기능 | 상태 | 비고 |
|---|---|---|
| CSS `transform: translate` | O | 유일하게 믿을 수 있는 배치 수단 |
| CSS `transform: rotate` | X | computed엔 남지만 bbox 불변 → 시각 미적용 |
| 복합 transform (`translate() rotate()`) | X | matrix로 합성 안 됨. 중첩 div로도 rotate 자체가 X |
| CSS `conic-gradient` | X | `none` 반환. 색상환은 색점 배치로 근사 |
| CSS `radial-gradient` / `border-radius` | O | |
| `<canvas>` 2D 그리기 | O | 단 `getImageData`/`drawImage`/`toDataURL`/`createConicGradient` 전부 X |
| `<canvas>` 드래그 중 실시간 갱신 | X | 리페인트 때 검게 클리어됨(블랙아웃) → DOM으로 대체 |
| `<input type="range">` | X | 0×0, 렌더 안 됨 → 커스텀 div 슬라이더 |
| SVG (`<svg>`, `<circle>` …) | X | 요소는 생기나 0×0 |
| `PointerEvent`, `setTimeout`, `requestAnimationFrame` | O | 커스텀 슬라이더/코얼레싱의 토대 |

**조작 중 시각화 갱신은 native 리페인트를 오버로드한다**
UXP는 DOM을 native UI로 매핑하므로, 드래그 중 매 input마다 팔레트·컬러휠을 다시
그리면 JS 시간(측정 <1ms)엔 안 잡히는 native 리페인트 비용이 쌓여 버벅임과
블랙아웃을 만든다. 실측: sp-slider 드래그 시 프레임 간격 중앙값 124ms(~8fps).
대응 — 시각 갱신을 rAF로 프레임당 1회 코얼레싱, 무거운 요소는 translate 기반으로,
미리보기 픽셀 렌더(~90ms) 같은 무거운 작업은 조작이 멈춘 뒤 디바운스로만 실행.

**canvas `clearRect`는 불투명(검정)으로 지운다 — 지금은 컬러휠에 canvas를 안 쓴다**
두 canvas를 겹쳐 배경/전경을 나누면 전경 `clearRect`가 배경을 검게 가린다. 단일
canvas에선 clearRect 직후 배경을 덮으면 되지만, 드래그 실시간 갱신에서는 UXP
리페인트가 canvas를 검게 만들어 블랙아웃이 났다. 캐싱 수단도 없어, 결국 컬러휠을
DOM(translate 전용)으로 옮겼다. 위 "컬러휠" 및 미지원 목록 참고.

**`get`은 레이어의 `blendRange`를 반환하지 않는다**
레이어 디스크립터를 `get`으로 읽어도 `blendRange` 키가 없고, 속성을 명시 조회하면
`-25920` 오류가 난다. Blend If가 적용됐는지는 디스크립터로 확인할 수 없다.
동작 검증은 픽셀 측정으로 해야 한다 (아래 참고).

**batchPlay `make` Channel Mixer는 대각선이 0으로 생성된다**
UI로 채널 믹서를 만들면 각 출력 채널의 자기 소스가 100%(항등)지만, `make`로 만들면
전부 0이 되어 이미지가 검게 된다. 대각선을 명시적으로 100 넣어야 한다.
또한 출력/소스 채널 키에서 green은 `grain`이다 (`channelMatrix`의 `red`/`grain`/`blue`).

## 검증 상태

Photoshop 27.7.0 (2026)에서 실제 실행하여 확인한 항목:

| 항목 | 결과 |
|---|---|
| 플러그인 로드 / 패널 렌더 | 정상 |
| 프리셋 시딩 (데이터 폴더에 JSON 2개 생성) | 정상 |
| 프리셋 목록 UI 반영 | 정상 (2개, 카테고리 접두사 포함) |
| 파이프라인 적용 후 레이어 순서 | 설계대로 (아래 그레이딩 → 할레이션 → 그레인 위) |
| 블렌드 모드 / 불투명도 | Halation `screen 45%`, Grain `overlay 25/45/15%` |
| 커브 레이어 조건부 생성 | toe/shoulder/게인이 모두 중립이면 생성 안 함 (의도대로) |
| **명암별 차등 그레인** | **정상** — 아래 측정치 |
| **크로스토크 매트릭스** (v2) | **정상** — 아래 측정치 |
| **미리보기 패널 (실제 사진)** (v2) | **정상** — imaging 파이프라인, 별도 패널 도킹, 크기 안정 |
| **멀티패널 분리** (v2) | **정상** — 두 패널 같은 JS 컨텍스트, show event=패널 노드 |
| **팔레트 미리보기** (v2) | **정상** — 15 스와치 렌더, 시뮬레이션 방향성 검증 |
| **컬러휠 시각화** (v2) | **정상** — DOM translate, 색상환·마커·경로 실시간 |
| **컬러휠 마커 편집** (v2) | **정상** — 드래그 시 색역 자동 판정·칩·슬라이더 연동 |
| **무채색 미니휠 + 탭** (v2) | **정상** — 탭 전환, 톤별 미니휠 3개 드래그 |
| **색역 칩 (sp-picker 대체)** (v2) | **정상** — 수동 선택·자동 선택 모두 연동 |
| **더블탭 리셋** (v2) | **정상** — 마커·미니휠·슬라이더 기본값 복귀 |
| **레이어 그룹화 + 덮어쓰기** (v1.1) | **정상** — 재적용해도 FilmSim 그룹 children 2 유지 |
| **사진 기반 대표색** (v1.2) | **정상** — 색역별 채도가중 대표(스킨 175,143,122 등) |
| **세부 휠 (밝기 세분)** (v1.2) | **정상** — 선택 색역 밝기 4구간 대표, 색역 전환 연동 |
| **커스텀 슬라이더** (v2) | **정상** — 드래그 부드러움, 블랙아웃 없음 |
| **패널 세로 스크롤** (v2) | **정상** — scrollHeight > clientHeight |

그레인 존 마스킹 측정: 휘도 20/80/128/190/245의 5개 밴드에 중간톤 그레인만 100으로 적용한 뒤
각 밴드의 픽셀 표준편차를 측정.

| 밴드 휘도 | 20 | 80 | 128 | 190 | 245 |
|---|---|---|---|---|---|
| 표준편차 | 0 | 44.9 | 95.2 | 27.6 | 0 |

암부와 명부에서 그레인이 완전히 억제되고 중간톤에서 최대. 설정한 존 범위 [60, 195] +
페더 40과 일치한다.

크로스토크 측정: 순수 빨강 `(255,0,0)`에 대칭 강도 20%(매트릭스 `[[60,20,20],[20,60,20],[20,20,60]]`)를
적용한 결과 픽셀.

| | R | G | B |
|---|---|---|---|
| 기대 | 153 | 51 | 51 |
| 측정 | 153 | 51 | 51 |

`R = 0.6·255 = 153`, `G = B = 0.2·255 = 51`. 정확히 일치하여 채널 혼합이 의도대로 동작함을 확인.

미리보기 패널 측정: 활성 문서를 280px 썸네일로 읽어 grading을 픽셀마다 적용하는
전체 파이프라인이 getPixels 2ms + getData 1ms + grading 픽셀순회 85ms + encode 2ms
= 약 90ms. 별도 패널(`filmsim.preview`)로 분리해 도킹 가능, img src 교체 시 프레임
고정으로 레이아웃 안정 확인.

미검증: 배치 적용(폴더 선택 다이얼로그가 필요해 자동 검증 불가), 프리셋 가져오기/내보내기.

## 디버깅 (UDT GUI 앱 없이)

`uxp plugin logs` / `debug`는 별도 설치가 필요한 Electron 앱
(`@adobe/uxp-devtools-app`)을 실행하려 하며, 없으면 모듈 오류로 죽는다.
대신 CDP에 직접 붙을 수 있다.

전역 CLI에 넣은 훅 — `@adobe/uxp-devtools-cli`를 재설치하면 사라진다:

- `src/cli/commands/plugin/debug.js` — `UXP_PRINT_WS=1`이면 GUI를 띄우는 대신
  CDP 웹소켓 URL만 출력
- `.../uxp-devtools-core/src/core/client/connection/Connection.js`,
  `.../plugin/actions/PluginBaseCommand.js` — `UXP_DUMP_ERR=1`이면 앱이 보낸
  원본 오류 페이로드를 덤프

`Runtime.evaluate`는 `contextId`를 반드시 명시해야 한다. UXP는 기본 실행 컨텍스트를
노출하지 않아 생략하면 `Cannot find default execution context`가 난다.
`Runtime.executionContextCreated` 이벤트에서 id를 받아 쓸 것.

## 현재 한계 (v1)

- **그레인 입자 크기**는 노이즈 생성 후 가우시안 블러로 입자를 뭉쳐 근사한다.
  실제 은염 결정 형상은 재현하지 않는다. 정밀 제어는 `imaging` API로 픽셀에
  직접 접근해야 한다.
- **배치는 순차 처리.** 문서를 하나씩 열고 닫아 메모리 누적을 막는 대신 느리다.

(크로스토크 매트릭스, 레이어 그룹화는 구현 완료 — 위 "크로스토크"·"재적용은 덮어쓴다" 절 참고)

## 배치 적용 안전 규칙

- 출력 폴더를 원본 폴더와 다르게 지정해야 한다. 같으면 실행 전에 거부한다.
- 한 장이 실패해도 중단하지 않는다. 실패 목록은 완료 후 상태 표시줄에 나온다.
- 원본은 어떤 경우에도 수정되지 않는다 (`saveAs` + `asCopy`, 닫을 때 저장 안 함).
