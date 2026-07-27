# Moderate's Film Simulator — Photoshop UXP 플러그인

디지털 사진에 아날로그 필름의 광학적·화학적 특성을 재현하는 포토샵 플러그인.

색은 눈대중이 아니라 **제조사 기술자료(TDS)의 D-logE 특성곡선에서 유도**한다.
층별 곡선 기울기의 차이가 필름마다 다른 색감의 정체이고, 그 수치를 그대로 쓴다.
결과는 3D LUT으로 구워 문서에 적용하거나, `.cube` · Lightroom 프로파일로 내보낸다.

기획 문서는 [SPEC.md](./SPEC.md), 설계 근거는 [v2plan.md](./v2plan.md) 참고.

> **v2.0.0** — 플러그인이 **둘로 나뉘었다.** 색은 엔진이, 입자와 산란은 마감이
> 담당한다. 필름 9종(주광 8 + 텅스텐 Vision3 500T) · CineStill 800T 프리셋 ·
> 다중스케일 광학 할레이션. 스캐너 파라미터는 아직 튜닝값이다.
> [현재 한계](#현재-한계-v14)와 [남은 작업](./TODO.md)을 먼저 읽을 것.

## 두 개의 플러그인

| | **Engine** `com.filmsim.photoshop` | **Finish** `com.filmsim.finish` |
|---|---|---|
| 하는 일 | 필름 · 스캐너 · 노광 · 색 조정 | 필름 포맷 · 할레이션 · 그레인 |
| 산출 | 문서 적용 · `.cube` · Lightroom 프로파일 | 문서 적용 · 폴더 배치 |
| 입력 | 16bit RGB (ProPhoto 권장) | **8bit JPEG이 정상 입력** |
| 호스트 API | `imaging` (batchPlay 2줄) | `batchPlay` 전부 |

같은 문서에 겹쳐 쓰는 것이 정상이다. 레이어 접두사가 `FilmSim Color` /
`FilmSim Finish`로 갈려 서로의 결과를 지우지 않는다.

**왜 나눴나.** 색은 순수 계산이고 마감은 Photoshop 액션이다. 섞여 있으면
마감 쪽을 손보다 색이 망가질 수 있는데, 그 실수는 결과를 보기 전까지 드러나지
않는다. 나눠 두면 마감 플러그인에 색 코드가 **아예 들어 있지 않아** 물리적으로
불가능해진다.

## 설치 (일반 사용자 — 개발자 툴 불필요)

1. Photoshop 2023 (v24) 이상을 설치한다.
2. 최신 `.ccx`를 내려받는다 — 필요한 것만 받아도 된다.
   - [엔진(색) `com.filmsim.photoshop_PS.ccx`](https://github.com/Moder4te/moderates-film-simulator/releases/latest/download/com.filmsim.photoshop_PS.ccx)
   - [마감(할레이션·그레인) `com.filmsim.finish_PS.ccx`](https://github.com/Moder4te/moderates-film-simulator/releases/latest/download/com.filmsim.finish_PS.ccx)

   ([전체 릴리스 목록](https://github.com/Moder4te/moderates-film-simulator/releases))
3. `.ccx`를 더블클릭한다. Adobe 플러그인 설치 관리자(Creative Cloud와 함께 설치됨)가
   설치를 진행한다. "확인되지 않은 게시자" 경고가 나오면 설치를 허용한다(자체 서명).
4. Photoshop을 재시작한다.
5. `플러그인` 메뉴에 **Film Sim 엔진**·**Film Sim 미리보기**·**Film Sim 마감**이
   나타난다. 미리보기 패널을 엔진 옆에 도킹하면 된다.

두 플러그인은 독립이라 하나만 설치해도 동작한다. 색만 필요하면 엔진, 이미 현상된
JPEG에 입자만 얹고 싶으면 마감.

설치형(.ccx)은 UXP Developer Tool이 필요 없고 Photoshop 재시작 후에도 유지된다.

## 개발 (소스에서 로드)

1. [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/devtool/) 설치
2. Photoshop 실행 (2023 / v24 이상)
3. **`node tools/sync-libs.js`** — 공유 층을 각 앱의 `lib/`로 복사한다.
   이걸 안 하면 앱이 `core`를 찾지 못해 로드에 실패한다
4. UDT에서 **Add Plugin** → `apps/engine/manifest.json` 또는
   `apps/finish/manifest.json` 선택 → **Load**. 둘 다 올려도 된다
5. 코드 수정 후 UDT **Reload**. `core/`를 고쳤으면 **sync-libs를 먼저 돌린다**

패키징(.ccx 두 개 생성):

```bash
uxp service start          # 별도 터미널. 떠 있어야 packaging이 된다
node tools/build-ccx.js    # sync-libs를 자동으로 먼저 돌린다
uxp service stop           # ⚠️ 반드시 끈다
```

`uxp service`가 떠 있으면 **UDT GUI가 포트 14001을 못 잡아** 플러그인 로드가
`Cannot read property 'loadPlugin' of undefined`로 실패한다. 패키징이 끝나면
반드시 끈다(UXP-NOTES 1.2.5).

`uxp plugin package`를 앱 폴더에서 직접 돌리면 안 된다 — **manifest가 있는 폴더를
통째로 담고 제외 옵션이 없다.** 저장소 루트에서 돌렸을 때 `.git`이 전부 실려
13.2MB가 나온 적이 있다(v1.2.0 배포판). `tools/build-ccx.js`가 런타임 파일만
`build/<app>/`에 모아 거기서 패키징한다. 결과는 engine 81KB / finish 26KB.

## 문서

| 파일 | 내용 |
|---|---|
| [`TODO.md`](./TODO.md) | **남은 작업** — 우선순위, 착수 방법, 완료 기준. 작업 재개는 여기부터 |
| [`UXP-NOTES.md`](./UXP-NOTES.md) | **Photoshop UXP 실측 지식** — 함정, 성능, 프로파일 포맷, 검증 방법론. 다른 UXP 플러그인에도 그대로 쓰인다 |
| [`v2plan.md`](./v2plan.md) | 설계 문서 — 결정과 그 근거, 실측 로그 |
| [`SPEC.md`](./SPEC.md) | 원본 기능 명세 |
| [`tools/README.md`](./tools/README.md) | TDS 곡선 추출기 사용법과 함정 |

## 파일 구조

```
core/                  순수 계산. photoshop·uxp·DOM 접근 금지 (검사로 강제)
  color/               curve films film scanner lut colorspace simulate
                       gamut     색역 판정·HSV — 컬러휠과 사진 분석이 공유
                       analysis  색역별 누적·대표색 (순수. 노드에서 시험 가능)
  optics/              format          필름 포맷 → 입자 크기 물리
  io/                  cube xmp xmpcodec   직렬화만, 파일 쓰기는 앱이 한다
host/                  UXP 경계. batchPlay 디스크립터는 여기서만
  ps.js
shared/ui/             cslider
apps/
  engine/              필름 엔진 플러그인
    manifest.json  index.html
    src/               main params pipeline apply preview colorwheel
                       photoanalysis(어댑터) presets
    lib/               ← sync-libs.js가 core/color·core/io·host·shared 복사
  finish/              마감 플러그인
    manifest.json  index.html
    src/               main params pipeline halation grain batch presets
    lib/               ← core/optics·host·shared 만. 색이 없다
tools/
  check.js             전체 검사 (문법·경계·로드·정합성)
  sync-libs.js         공유 층을 각 앱 lib/로 복사
  build-ccx.js         .ccx 두 개 패키징
  extract_tds_curves.py
```

`apps/*/lib/`는 산출물이다. `core/`가 원본이고, 거기를 직접 고치면 다음 sync에
지워진다.

## 개발 검사

코드를 고쳤으면 실기에 올리기 전에 돌린다. 3초면 끝나고, 실기 진단은 오류
메시지가 엉뚱해서 한 번에 30분씩 든다.

```bash
node tools/check.js
```

| 검사 | 보는 것 |
|---|---|
| 문법·BOM | 파싱되는가. manifest BOM은 플러그인을 아예 못 올린다 |
| 경계 | core 순수 / batchPlay 격리 / 마감 앱에 색 없음 / 레이어 접두사 분리 |
| 로드 | 두 앱이 예외 없이 뜨는가. 없는 id를 참조하지 않는가 |
| 정합성 | 네 산출 경로(적용·`.cube`·`.xmp`·미리보기)가 같은 색을 내는가 |

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
색(엔진) → [마감] 디퓨전 → 할레이션 → 그레인. 그레인이 최상단이라야 이후 보정에
노이즈가 증폭되지 않는다. 디퓨전(번짐)은 할레이션보다 **먼저**다 — 디퓨전이
stampVisible/getPixels로 합성본을 잡으므로, 할레이션이 먼저 있으면 그 픽셀이
디퓨전 레이어에 구워져 나중에 할레이션을 끌 수 없다(v2.7.2).

**Photoshop 채널 열거자 주의**
ActionDescriptor에서 green 채널의 값은 `"grain"`이다. `"green"`이 아니다.
`grading.js`와 `halation.js` 양쪽에 해당한다.

## UXP 함정 (실제로 부딪힌 것들)

**manifest.json에 BOM이 붙으면 플러그인을 못 올린다**
UDT의 Add Plugin이 `Unexpected token ﻿ in JSON at position 0`으로 거부한다.
UTF-8 BOM(`EF BB BF`) 3바이트가 JSON 파서에 그대로 들어가기 때문이다.
Windows에서 PowerShell의 `Out-File -Encoding utf8` / `Set-Content`로 저장하면
**BOM이 자동으로 붙는다.** 편집기·스크립트가 무엇을 쓰는지 확인할 것.

```bash
head -c 3 manifest.json | xxd -p        # efbbbf 나오면 BOM
git ls-files | while read f; do [ "$(head -c 3 "$f" | xxd -p)" = efbbbf ] && echo "$f"; done
```

JS 파일의 BOM은 엔진이 공백으로 넘겨 대개 조용히 지나가지만, manifest는 즉사한다.

**같은 플러그인 ID를 개발판과 설치판이 동시에 가질 수 없다**
릴리스판(.ccx)을 설치해 둔 채 UDT로 같은 `id`의 개발판을 올리면 로드가 실패한다.
Photoshop 재시작 시 설치판이 먼저 ID를 선점하므로, **재시작 전에는 되다가 재시작 후
안 되는** 형태로 나타나 원인을 짚기 어렵다. 등록 상태는 여기서 확인한다.

```
%APPDATA%\Adobe\UXP\Plugins\External\        설치판
%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<버전>\{Developer,External}\<id>\
```

개발 중에는 설치판을 제거한다. 프리셋은 위 `PluginsStorage\...\PluginData\presets`에
있으므로 제거 전에 따로 복사해 둘 것.

**`TextEncoder`가 없다**
UXP 버전에 따라 전역에 존재하지 않는다. 노드나 브라우저에서 테스트하면 멀쩡히
통과하므로 실기에서만 터진다. 게다가 루프 안에서 쓰면 항목마다 같은 예외가 나서
**"전부 실패"로만 보이고 원인이 드러나지 않는다** (프로파일 16개 내보내기가 이렇게
전멸했다). UTF-8 인코딩은 `xmpcodec.utf8`로 직접 한다.

같은 이유로 반복 작업의 실패 처리는 개수만 세면 안 된다. **첫 실패의 메시지를
그대로 보여주고 즉시 멈춰라** — 환경 문제면 나머지도 같은 이유로 죽는다.

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
| **사면체 보간** (v1.4) | **정상** — 항등 LUT 오차 0 (17³/33³/65³, 6갈래 분기 전부) |
| **`putPixels` 적용 경로** (v1.4) | **정상** — 60.2MP 왕복 3.4초 |
| **LUT 생성 비용** (v1.4) | 65³ 2ms — 캐시 불필요 |
| **미리보기 성능** (v1.4) | 512px 29fps — WASM 없이 목표 초과 |
| **TDS 곡선 추출** (v1.4) | **정상** — 시각 판독 4건과 농도 0.01 일치, ISO 역산 Portra 399.5 / Gold 207.2 |
| **`.cube` 내보내기** (v1.4) | **정상** — Photoshop Color Lookup 수동 로드 확인 |
| **ACR 프로파일 생성** (v1.4) | **정상** — 전 격자점 왕복 오차 7.6e-6(반 LSB), 픽셀 적용과 Difference 판정 일치 |
| **프로파일 세트 16개** (v1.4) | **정상** — 339ms, 독립 디코더·XML 파서 전수 통과 |

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

## 현재 한계 (v1.4)

**데이터**

- **스캐너 파라미터는 측정값이 아니다.** Frontier / Noritsu는 현상소 비교 문헌의
  정성 서술을 수치로 옮긴 튜닝값이다. 공개된 스캐너 특성 데이터를 찾지 못했다.
  코드(`src/scanner.js`)와 문서에 그렇게 표시해 뒀다.
- **Agfa 2종의 Log H Ref는 추정값이다.** Agfa TDS는 노광축이 절대값이 아니라
  필름 정규화라 감도점 + 1.01로 유도했다. Kodak 5종에서 확인된
  `Log H Ref = log10(14.4 / ISO)` 관계는 Agfa에 그대로 적용할 수 없다.
- **중간 그레이 앵커 오프셋이 0으로 박혀 있다.** 기준이 되는 "정답 스캔"이 없어
  추정값을 넣지 않았다(`src/film.js`의 `MID_GRAY_OFFSET`). 레퍼런스가 생기면
  이 상수 하나를 한 번만 맞춘다.

**적용**

- **적용은 픽셀 레이어라 비파괴가 아니다.** batchPlay로 Color Lookup에 LUT을
  주입하는 경로가 막혀 `putPixels`를 쓴다. 비파괴·GPU 가속이 필요하면 `.cube`를
  내보내 Color Lookup 조정 레이어에 수동으로 넣는 우회로가 있다.
- **16bit 문서 전용.** 32bpc에서는 Photoshop이 Color Lookup과 Selective Color를
  비활성화한다.
- **배치는 순차 처리.** 문서를 하나씩 열고 닫아 메모리 누적을 막는 대신 느리다.
- **적용 순서는 색 → 마감이어야 한다.** 마감의 디퓨전 레이어는 그 시점 합성본을
  구운 **파괴적 스탬프**라, 마감을 먼저 얹은 뒤 엔진(색)을 적용하면 그 스탬프된
  픽셀은 다시 색을 입힐 수 없다 — 색이 중복되거나(스탬프에 구워진 원본색 + 새 색)
  덮여 미적용된 것처럼 보인다. 엔진은 재적용 시 FilmSim 레이어를 격리해 중복
  자체는 막지만, 이미 구워진 디퓨전 픽셀까지 되돌릴 수는 없다. **색을 먼저
  확정하고 마감을 얹는 것이 올바른 파이프라인이다**(설계상 순서). 남겨둔 한계.

**광학**

- **그레인은 값 노이즈로 생성한다**(v2.7). 셀을 키우면 대비를 유지한 채 blob이
  커진다 — 블러로 뭉치던 예전 방식은 굵을수록 대비가 떨어져 mush가 됐다. 다만
  실제 은염 결정의 정확한 형상까지 재현하진 않는다.
- **유효 입자 크기가 필름별로 다르지 않다.** 포맷과 감도(ISO)로만 정해진다. 실제로는
  Ektar 100과 Portra 800의 입자 크기가 크게 다르다. TDS의 입자도 지표(PGI)는
  구형 RMS granularity와 변환 관계가 없다고 Kodak이 명시해 뒀다.

**프로파일**

- `crs:Version`을 실측 파일에서 가져와 고정값으로 쓴다. 다른 ACR 버전에서의
  호환 범위는 확인하지 못했다.
- 색공간은 ProPhoto / sRGB 두 조합만 실측했다. Adobe RGB · P3는 값을 모르므로
  넣지 않았다.

## 두 가지 모드

플러그인은 역할이 나뉜다. **필름 카드의 체크박스가 모드 전환**이다.

| | 필름 켬 — 색 | 필름 끔 — 마감 |
|---|---|---|
| 하는 일 | TDS 특성곡선으로 색을 정한다 | 색은 그대로 두고 할레이션·그레인·보정을 얹는다 |
| 입력 | 16bit RGB (ProPhoto 권장) | **8bit JPEG이 정상 입력** |
| 쓰는 때 | raw에서 룩을 만들 때 | 이미 현상된 파일을 마감할 때 |

Lightroom 프로파일로 현상한 JPEG에 입자와 할레이션만 얹고 싶다면 **필름을 끄고**
쓴다. 그 상태에서는 8bit 경고가 뜨지 않는다.

## 매체 — 필름 포맷과 입자 크기 — v1.5

입자 크기는 **필름면에서 고정**이다. 최종 이미지에서 35mm과 4×5의 입자가 달라
보이는 것은 확대율 차이 때문이다. 그 물리를 그대로 계산한다.

```
px_per_mm = 이미지_긴변_px / 프레임_긴변_mm
grain_px  = (유효입자_µm / 1000) × px_per_mm
```

10µm 입자를 긴 변 6000px으로 낼 때:

| 포맷 | px/mm | 입자 크기 |
|---|---|---|
| 35mm | 166.7 | 1.67 px |
| 6×7 | 85.7 | 0.86 px |
| 4×5″ | 47.2 | 0.47 px |

그레인 크기는 **필름 감도(ISO)** 로 받는다(v2.8) — 감도가 곧 입자 크기다. ISO
50~3200이 필름면 4~25µm에 대응하고, 기본 400이 10µm(위 표의 Portra 400 지점).
슬라이더는 로그(스톱) 스케일이다. µm 대응은 추정값이다(PGI↔RMS 변환 불가).
할레이션 반경도 같은 이유로 포맷에 따라 좁아진다.

**입자 크기 기준** — 기본은 문서 픽셀 그대로다. 작업 파일과 최종 출력 크기가
다를 때(9504px로 작업하고 2048px로 웹에 올릴 때 등) 6000 / 9000 또는 직접 입력으로
고정하면 그 크기에서 맞는 입자를 만든다. 더 간단히는 **출력 크기로 리사이즈한 뒤
마감을 적용**하면 문서 기준 그대로 맞는다.

`grain_px`가 1px 미만이면 블러를 걸지 않고 노이즈 강도로 환산한다 — 픽셀보다 고운
입자는 그 자리에서 평균되어 변조 진폭이 줄어드는 것이 실제 거동이다.

## 그레인 생성 — 값 노이즈 다이클라우드 (v2.7~2.8)

블러로 큰 입자를 흉내내던 방식을 버리고 값 노이즈(`core/optics/grainfield.js`)로
텍스처를 생성한다. 최근 변경을 한눈에:

- **값 노이즈** — 셀(=입자 px)을 키우면 **대비를 유지한 채** blob이 커진다. 블러로
  뭉치던 예전 방식은 굵을수록 대비가 떨어져 mush가 됐다(사용자 실측 지적). 채널별
  진폭(청색을 시끄럽게)·클럼프 옥타브를 필드에 함께 굽고, 텍스처 한 벌을 세 존이
  Overlay로 공유한다.
- **감도(ISO)** — 추상 크기 슬라이더를 ISO 50~3200으로 교체. `µm = 10·(ISO/400)^0.44`.
  감도가 곧 입자 크기라 근거가 하나로 합쳐진다.
- **번짐 변위 기본** — 블러 대신 입자 크기 셀 단위로 이웃을 무작위로 집어 미세 선을
  **조각낸다**. 블러가 남기는 흐린 잔상 없이 그레인다움을 유지한다.
- **디퓨전 → 할레이션 → 그레인** 순서 — 디퓨전을 할레이션보다 먼저 돌려 할레이션이
  독립 레이어로 남는다(적용 후 켜고 끌 수 있다).
- **격자 완화 블러** — 굵은 입자의 smoothstep 마디가 각져 보이는 것을 미세 블러로
  눌러준다. 감도·해상도에 비례(장축 9000px 기준; 저해상도면 함께 줄어 mush 방지).
- **메모리** — 색 모드에서 채널 필드를 하나씩 생성·소비·폐기해 대형 문서(266MP)
  순간 점유를 1/3로 줄였다.

## LUT 내보내기 (.cube) — v1.4

패널의 "LUT 내보내기" 카드에서 현재 설정을 `.cube` 파일로 뽑는다. 내보낸 LUT은
"현재 문서에 적용"과 **같은 결과**를 낸다 (유제 → 스캐너 → 색 조정까지 전부 구워짐).

**격자** 33³ / 65³. 33이 Photoshop·Camera Raw 표준, 65는 정밀도용.

**색공간** — 기본값 **ProPhoto γ1.8**을 쓰면 된다. 엔진이 굽는 공간 그대로이고
아래 두 경로 모두 이 공간을 받는다. "Camera Raw (폴백)"은 New Profile에 색공간
드롭다운이 없는 구버전에서만 쓴다.

### 1. Photoshop — Color Lookup 조정 레이어

조정 레이어 → 색상 검색 → 3DLUT 파일 → 내보낸 `.cube` 로드. 문서가 **ProPhoto**여야 한다.

**GPU 가속 + 비파괴**라 대용량 파일에서는 플러그인의 픽셀 적용보다 빠르다.

## Lightroom 프로파일 (.xmp) — v1.4

**"Lightroom 프로파일" 카드 → 세트 전체.** 폴더를 고르면 필름 × 스캐너 조합
16개를 `.xmp` 프로파일로 한 번에 쓴다 (개당 약 20ms, 242KB).

사용자 설치는 폴더에 복사하고 Lightroom을 재시작하면 끝이다.

```
Windows  %APPDATA%\Adobe\CameraRaw\Settings\
macOS    ~/Library/Application Support/Adobe/CameraRaw/Settings/
```

Profile Browser의 **FilmSim** 그룹에 전부 뜨고 강도 슬라이더도 붙는다.
Lightroom · Lightroom Classic · Camera Raw 공통이다.

프로파일은 32³ ProPhoto로 굽는다 — ACR이 프로파일 안에 담는 격자 크기가 32이고,
더 큰 LUT을 넣어도 32로 줄어들기 때문이다. 엔진에서 바로 32³을 구우면 리샘플링이
한 번도 일어나지 않는다.

### 아래 대화상자 경로보다 나은 점

| | 대화상자 | 직접 생성 |
|---|---|---|
| 프로파일 16개 만들기 | 클릭 100여 회 | 버튼 1회 |
| 보간 횟수 | 2회 (엔진→65³→ACR 32³) | 1회 (엔진→32³) |
| 엔진 수정 후 재생성 | 전부 다시 손으로 | 버튼 1회 |

대화상자 경로는 `.cube`를 다른 앱에서도 쓰고 싶을 때 남겨둔다.

### 2. Lightroom / Camera Raw — 대화상자로 만들기 (.cube에서)

Adobe가 .cube → 프로파일 변환을 Camera Raw 안에 넣어놨다.

1. Photoshop에서 **필터 → Camera Raw 필터** (`Shift+Ctrl+A`)
2. 오른쪽 세로 아이콘 줄에서 **Presets** (동그라미 두 개 겹친 아이콘)
3. **Alt(Option)를 누른 채** `+` 클릭 → "New Profile" 대화상자
   (Alt 안 누르면 그냥 프리셋 만들기가 뜬다)
4. 체크박스 전부 해제 → **Color Look-Up Table만 체크**
5. 색공간 드롭다운에서 **ProPhoto RGB** 선택
6. 내보낸 `.cube` 지정 → 이름 입력 → OK

Lightroom · Lightroom Classic · Camera Raw의 Profile Browser에 뜨고 강도 슬라이더도 붙는다.

> 5번 색공간을 틀리면 **검정이 뜨고 전체가 파르스름해진다.** 암부가 최대 1스톱
> 뜨고 18% 그레이의 색조가 웜에서 쿨로 뒤집힌다. 플러그인의 "현재 문서에 적용"
> 결과와 나란히 비교하면 바로 보인다.

ACR 10.3 이상 필요.

## 배치 적용 안전 규칙

- 출력 폴더를 원본 폴더와 다르게 지정해야 한다. 같으면 실행 전에 거부한다.
- 한 장이 실패해도 중단하지 않는다. 실패 목록은 완료 후 상태 표시줄에 나온다.
- 원본은 어떤 경우에도 수정되지 않는다 (`saveAs` + `asCopy`, 닫을 때 저장 안 함).

## 라이선스

**[PolyForm Noncommercial License 1.0.0](./LICENSE.md)** — 소스 공개, **비상업 용도만**.
개인·연구·교육·취미 등 비상업 목적으로 자유롭게 쓰고 수정·재배포할 수 있으나
상업적 이용은 허용되지 않는다.

- **제조사 TDS PDF는 재배포하지 않는다.** 저장소에는 그래프에서 추출한 수치
  데이터만 있고, 원본 PDF는 `.gitignore`로 제외한다(`films.js`의 `source` 필드에 출처 기록).
- **상표는 명목적 사용만.** "Kodak Portra", "Fuji", "CineStill" 등은 재현 대상
  필름을 가리키는 지시적 표기이며, 로고·서체는 쓰지 않는다. 제조사와 무관한
  비공식 프로젝트다.
- 스캐너 색·프로파일 등 외부 데이터는 상업 재배포를 막는 소스(GPL/NC 등)를 피해
  선택지를 열어 뒀다.

## 상표 고지 (Trademarks)

이 프로젝트에 등장하는 모든 제품명·필름명·브랜드명은 **각 소유자의 상표 또는
등록상표**다. 예: KODAK · PORTRA · EKTAR · GOLD · ULTRAMAX · VISION3 (Eastman
Kodak Company / Kodak Alaris), FUJIFILM · FRONTIER (Fujifilm), CINESTILL
(CineStill Film), NORITSU (Noritsu), AGFA (Agfa), ADOBE · PHOTOSHOP · LIGHTROOM ·
CAMERA RAW (Adobe Inc.).

- 이 프로젝트는 **비공식이며 위 어떤 회사와도 제휴·후원·보증 관계가 없다.**
  각 상표권자가 만들거나 승인한 것이 아니다.
- 상표는 오직 **재현 대상 필름·스캐너·소프트웨어를 식별하기 위한 지시적(명목적)
  사용**이다. 로고·서체·트레이드드레스는 쓰지 않는다.
- 이 플러그인의 결과물은 해당 실제 제품의 출력을 **정확히 재현한다고 주장하지
  않는다** — 공개 기술자료(TDS)에서 유도한 근사이며, 상표권자가 검증한 바 없다.
- 상표는 각 소유자의 재산으로 존중하며, 여기서의 언급이 그 권리에 어떤 영향도
  주지 않는다. 상표권자의 요청이 있으면 표기 방식을 조정한다.

> **면책.** 위 상표의 사용은 식별 목적의 명목적 사용에 한하며, 어떠한 제휴·보증도
> 의미하지 않는다. 소프트웨어는 [LICENSE.md](./LICENSE.md)에 따라 **어떠한 보증도
> 없이 있는 그대로** 제공되고, 저작자는 그 사용으로 인한 어떠한 손해에도 책임지지
> 않는다.
