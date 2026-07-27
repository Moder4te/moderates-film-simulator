# 구조

> **성격: 정적.** 구조를 바꿀 때만 갱신한다.
> 코드를 고치기 전에 읽는다 — **불변식**을 깨면 `tools/check.js`가 실패한다.
> 왜 이 구조인지는 [`DECISIONS.md`](./DECISIONS.md).

## 층

```
core/     순수 계산. photoshop·uxp·DOM 접근 금지 (검사로 강제)
  color/    curve films film scanner lut colorspace simulate gamut analysis
  optics/   format grainfield displace
  io/       cube xmp xmpcodec        직렬화만. 파일 쓰기는 앱이 한다
host/     UXP 경계. batchPlay 디스크립터는 여기서만
  ps.js
shared/   ui/cslider
apps/
  engine/   필름 엔진 플러그인 (색)
    src/    main params pipeline apply preview colorwheel photoanalysis presets
    lib/    ← sync-libs.js가 core/color · core/io · host · shared 를 복사
  finish/   마감 플러그인 (광학)
    src/    main params pipeline halation grain batch presets
    lib/    ← core/optics · host · shared 만. 색이 없다
tools/    check* sync-libs build-ccx extract_tds_curves.py
```

`core/`가 순수하면 **노드에서 그대로 돌려 값을 전수 대조할 수 있다.** 색 검증
가능성이 여기서 나온다. 호스트 API가 한 줄이라도 섞이면 사라진다.

`apps/*/lib/`는 **산출물**이다. `core/`가 원본이고, `lib/`를 직접 고치면 다음
`sync-libs.js`에 지워진다. 복사 목록(`tools/sync-libs.js`의 `LIBS`)이 곧 경계 선언이다.

## 불변식 — 깨면 검사가 실패한다

`tools/check-boundaries.js`가 정적으로 강제한다. 규칙 번호는 그 파일의 주석과 같다.

| # | 불변식 | 깨지면 |
|---|---|---|
| 1 | `core/`가 `photoshop`/`uxp`/DOM을 부르지 않는다 | 노드 검증 불가 |
| 2 | `batchPlay` 직접 호출은 `host/` 안에만 | 디스크립터가 흩어져 추적 불가 |
| 2.5 | 디스크립터를 여러 개 내는 헬퍼(`stampVisible`)는 `...`로 펼쳐 쓴다 | 배경이 덮여 원본 소실 |
| 2.7 | `getPixels` 값은 심도 정규화 + 색공간 변환 후 쓴다 (왕복 경로는 예외) | 16bit·ProPhoto에서 색 붕괴 |
| 3 | 마감 앱은 `core/color`를 참조하지 않는다 | 분리 취지 소멸 |
| 4 | 두 앱의 레이어 접두사가 겹치지 않는다 | 한쪽이 다른 쪽 결과를 지움 |
| 5 | 앱 진입 모듈이 앱 밖(`../`)을 참조하지 않는다 | 패키징 시 파일 누락 |
| 6 | 엔진 재적용 격리 (아래) | 색 중복 적용 |

**규칙 6 상세** — 세 가지를 함께 본다.

- `pipeline.run`이 `clearOwnLayers`를 부른다 (안 부르면 재적용이 누적)
- `clearOwnLayers`가 **재귀**로 훑는다 (`l.layers` — 그룹 안 레이어를 못 지우면 누적)
- `applyLut`·`preview`가 **`getPixels` 전에** FilmSim 레이어를 숨기고 **반드시 복원**한다

`tools/check-conformance.js`는 값이 아니라 **구조**도 본다 — "엔진 함수를 부르는 곳이
몇 군데인가"를 세어, 각 경로에 같은 변환을 복붙한 구조를 잡아낸다.

## 파이프라인

### 전체 순서

```
Camera Raw (중립 현상, ProPhoto 16bit)
   ↓
[엔진]  필름 → 스캐너 → 색 조정  →  3D LUT 한 장  →  putPixels
           "FilmSim Color · Color" 픽셀 레이어
   ↓
[마감]  디퓨전 → 할레이션 → 그레인
           "FilmSim Finish · …" 레이어들 → 그룹
```

**색 → 마감 순서는 강제다.** 마감의 디퓨전은 합성본을 구운 파괴적 스탬프라
역순으로 하면 색을 다시 입힐 수 없다(→ [`STATUS.md`](./STATUS.md) 알려진 한계).

### 엔진 내부 — `apps/engine/src/pipeline.js`

```
clearOwnLayers(재귀)  →  film.hasEffect? → buildForParams(params, size) → applyLut
```

- **판단은 `film.hasEffect(params)` 하나로.** 호출자가 `film.enabled`를 직접 보지
  않는다 — 필름을 꺼도 그레이딩이 살아 있으면 적용할 것이 있다.
- `applyLut`은 다른 FilmSim 레이어를 숨긴 뒤 `getPixels` → LUT → `putPixels`,
  색 레이어를 마감 아래로 이동, 가시성 복원.

### 마감 내부 — `apps/finish/src/pipeline.js`

```
clearOwnLayers  →  grain.applyDiffusion  →  halation.apply  →  grain.applyGrain  →  그룹화
```

**디퓨전이 할레이션보다 먼저**여야 한다. 디퓨전이 `stampVisible`/`getPixels`로 합성본을
잡으므로, 할레이션이 이미 있으면 그 픽셀이 디퓨전에 구워져 나중에 할레이션을 끌 수 없다.

## 데이터 계약

### 필름 정의 — `core/color/films.js`

```jsonc
{
  "id": "kodak-portra-400",
  "type": "color-negative",        // | color-reversal | bw-negative — 반전 부호를 정한다
  "iso": 400,
  "balance": "daylight",           // | tungsten
  "source": { "document": "…", "logHRefAbsolute": -1.44, "method": "PDF 벡터 경로 좌표 추출" },
  "characteristicCurves": {        // x = 상대 로그노광 H (H=0 이 Log H Ref), y = 농도 D
    "r": [[-2.0, 0.219], …], "g": […], "b": […]
  },
  "printGamma": 1.806,             // 녹감층 실효대비가 1.0이 되도록 (1/γ_G)
  "crosstalk": [[100,0,0],[0,100,0],[0,0,100]],
  "tungstenCast": { "r": -0.04, "g": 0.08, "b": 0.06 },  // 선택. 텅스텐 필름만
  "grain": { "printGrainIndex": 37, "atMagnification": 4.4 },
  "exposureRange": [-2.0, 2.0]
}
```

- **H 축 규약**: `Log H Ref = log10(14.4 / ISO)`가 H=0. Kodak 5종에서 편차 0.022스톱으로
  확인됨. ⚠️ Agfa는 이 규약을 안 써서 곡선에서 앵커를 역산했다(추론값).
- **`type`을 빠뜨리면 엔진이 거부한다.** 조용히 네거티브로 처리하면 리버설이 뒤집힌다.
- 데이터 범위 밖은 `curve.js`가 발끝 기울기로 선형 외삽. PAVA 단조 보정이 물리적으로
  불가능한 하강을 막는다(데이터 파일은 TDS 그대로 두고 엔진에서 보정).

### 색 응답 — `core/color/film.js`

```
1. 인코딩 해제      L = v^WORKING_GAMMA
2. 로그 노광        H = log10(L/0.18) + 노광시프트 + tungstenCast
3. 특성곡선         D = curve(H)                    층별 농도
4. 반전/인화        P = 0.18 · 10^(pg·(D − D₀))     D₀ = curve(0)
5. 크로스토크 3×3
6. 스캐너 스테이지  레벨 → 틴트(3점) → S커브 → 채도
7. 화이트포인트     채널별 소프트 롤오프
```

**정규화 기준(`D₀`)에는 `tungstenCast`를 더하지 않는다.** 더하면 채널 정규화가
캐스트를 중화해 텅스텐 색이 사라진다. daylight 필름은 캐스트가 0이라 완전 불변.

**화이트포인트 이득은 노광 보정 0에서 고정**한다. 현재 노광에서 다시 계산하면
노광 보정이 스스로를 상쇄한다(+1스톱이 0스톱보다 어두워진 적 있음).

### 그레인 — `core/optics/grainfield.js`, `core/optics/format.js`

```
µm      = 10 · (ISO/400)^0.44          // 감도 → 필름면 유효 입자 지름 (4~25µm)
px_per_mm = 이미지_긴변_px / 프레임_긴변_mm
grain_px  = (µm / 1000) × px_per_mm
```

- **값 노이즈**(셀 격자 + smoothstep 보간)로 생성한다. 셀을 키우면 **대비를 유지한 채**
  blob이 커진다 — 가우시안 블러는 반경을 키우면 대비가 함께 떨어져 mush가 된다.
- 광대역: 미세 옥타브(cell) + 클럼프 옥타브(cell×2.6)의 합.
- 채널 진폭 차등(`dyeClouds`): 실측 R 1.23 / G 1.0 / B 1.76. **크기가 아니라 세기**다.
- `grain_px < 1`이면 블러를 끄고 강도로 환산한다.
- 격자 완화 블러 = `gridSmoothForIso(iso) × longEdge/9000` (장축 9000px 기준 튜닝값).

### 할레이션 — `apps/finish/src/halation.js`

```
buildRedSource: R 채널 smoothstep(임계, knee) × hsvTint(색조,채도) → putPixels
  ↓ 스케일마다 복제
Core   ×0.3  Color Dodge   colorize로 화이트닝
Mid    ×1.1  Linear Dodge  붉은 링 본체
Bleed  ×4.0  Linear Dodge  광역 헤일로
  ↓ 각 스케일에 채널 차등(DoG) 곱: r 1.0 / g 0.35 / b 0.22
원반(disk): Maximum 필터로 팽창 후 잔여 가우시안. Maximum은 1~100px 정수 상한.
```

- **추출은 적색 채널 구동**이다. 휘도로 뽑으면 포화 적색 네온(휘도 ~76)이 임계에
  안 걸려 붉은 오염이 아예 안 난다.
- **소스를 애초에 오렌지-레드로 칠한다.** 회색으로 뽑고 뒤에서 `colorize`하면 명도만
  보고 단색으로 덮어 채널 차등이 만든 링이 뭉개진다. 그래서 Mid·Bleed는 colorize 없음.
- 불투명도 = `strength × 스케일 가중`.

### LUT

- 격자: 프리뷰 33³ / 최종·익스포트 65³. 생성 비용 33³ 1ms · 65³ 2ms → **캐시 불필요**.
- 순서: `.cube` 규약(R 인덱스가 가장 빨리 변함).
- 보간: 사면체. 항등 LUT 오차 0(17³/33³/65³ 6갈래 분기 전부).

### Photoshop 값 범위

| 심도 | 범위 | 비고 |
|---|---|---|
| 8bit | 0~255 | |
| **16bit** | **0~32768** | 65535가 아니다. 15비트+1 |

`lut.maxValueFor(data)`로 판별한다. `getPixels`에 `componentSize: 8`을 주면 안 된다
(16bit 문서에서 무관한 에러로 죽는다 → [`UXP-NOTES.md`](./UXP-NOTES.md) 3.2).

## 산출 경로 — 넷이 같은 색을 내야 한다

```
buildForParams(params, size)
   ├─→ apps/engine/src/pipeline.js   문서 적용 (putPixels)
   ├─→ core/io/cube.js               .cube
   ├─→ core/io/xmp.js                Lightroom/ACR 프로파일
   └─→ apps/engine/src/preview.js    미리보기
```

**네 경로가 전부 `buildForParams`를 통과해야 한다.** 한 경로만 고치는 실수를
`tools/check-conformance.js`가 잡는다(최대차 실측: .cube 4.6e-7, .xmp 7.6e-6,
putPixels 3.7e-5).

## 레이어 이름

| 앱 | 접두사 | 예 |
|---|---|---|
| 엔진 | `FilmSim Color` | `FilmSim Color · Color` |
| 마감 | `FilmSim Finish` | `FilmSim Finish · Grain Midtone` |

같은 문서에 겹쳐 쓰는 것이 정상 사용이므로 **접두사 분리는 필수**다(불변식 4).
재적용 시 자기 접두사로 시작하는 레이어만 지운다.
