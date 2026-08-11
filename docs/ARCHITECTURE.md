# 구조

> **성격: 정적.** 구조를 바꿀 때만 갱신한다.
> 코드를 고치기 전에 읽는다 — **불변식**을 깨면 `tools/check.js`가 실패한다.
> 왜 이 구조인지는 [`DECISIONS.md`](./DECISIONS.md).

## 층

```
core/     순수 계산. photoshop·uxp·DOM 접근 금지 (검사로 강제)
  color/    curve films film scanner lut colorspace simulate gamut analysis
  optics/   format grainfield displace tone
  io/       cube xmp xmpcodec        직렬화만. 파일 쓰기는 앱이 한다
host/     UXP 경계. batchPlay 디스크립터는 여기서만
  ps.js     collectLayers(레이어 트리 재귀 탐색)도 여기 한 벌만 둔다
shared/   ui/cslider  paths(경로 비교 — 배치 원본 보호의 뿌리)
apps/
  engine/   필름 엔진 플러그인 (색)
    src/    main params pipeline apply preview colorwheel photoanalysis presets
    lib/    ← sync-libs.js가 core/color · core/io · host · shared 를 복사
  finish/   마감 플러그인 (광학)
    src/    main params pipeline grading halation grain batch presets
    lib/    ← core/optics · host · shared 만. 색이 없다
tools/    check(.js 문법·BOM) check-boundaries check-paths check-load check-api
          check-conformance check-tone · sync-libs build-ccx extract_tds_curves.py
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
| 2 | 앱에 `batchPlay`라는 **이름이 나오지 않는다** | 디스크립터가 흩어져 추적 불가 |
| 2.5 | 디스크립터를 여러 개 내는 헬퍼(`stampVisible`)는 `...`로 펼쳐 쓴다 | 배경이 덮여 원본 소실 |
| 2.7 | `getPixels` 값은 심도 정규화 + 색공간 변환 후 쓴다 (왕복 **함수**는 예외) | 16bit·ProPhoto에서 색 붕괴 |
| 3 | 마감 앱은 `core/color`를 참조하지 않는다 | 분리 취지 소멸 |
| 4 | 두 앱의 레이어 접두사가 겹치지 않는다 | 한쪽이 다른 쪽 결과를 지움 |
| 5 | 앱 진입 모듈이 앱 밖(`../`)을 참조하지 않는다 | 패키징 시 파일 누락 |
| 6 | 재적용 격리 — **두 앱 모두** (아래) | 색·그레인·할레이션 중복 적용 |

**규칙 6 상세** — 네 가지를 함께 본다. 앞의 둘은 **엔진과 마감 양쪽**에 건다.

- `pipeline.run`이 `clearOwnLayers`를 부른다 (안 부르면 재적용이 누적)
- `clearOwnLayers`가 **재귀**로 훑는다 (`ps.collectLayers` — 그룹 안 레이어를 못 지우면 누적)
- 마감의 `groupOwnLayers`는 **재귀로 훑지 않는다** — 방금 만든 최상위만 묶는 것이
  목적이라, 짝을 맞추는 개선처럼 보이는 재귀화가 과거 마감 레이어를 끌어내 묶는다
- `applyLut`·`preview`가 **`getPixels` 전에** FilmSim 레이어를 숨기고 **반드시 복원**한다

규칙 6은 원래 엔진에만 걸려 있었다. **더 파괴적인 쪽인 마감이 빠져 있었다** — 엔진
산출물은 픽셀 레이어 한 장이라 지우고 다시 하면 되지만, 마감의 디퓨전은 그 시점
합성본을 구워 놓아 되돌릴 지점이 없다(→ [`RESOLVED.md`](./RESOLVED.md)).

`tools/check-paths.js`는 **배치가 원본 사진을 덮어쓸 길이 없는지** 본다. 방어가
`shared/paths.js`의 `samePath`에 걸려 있는데, 그 함수가 `apps/finish/src/batch.js`
안에 있으면 노드에서 못 부른다(맨 위에서 `photoshop`·`uxp`를 require한다). 검사할 수
있는 자리에 두는 것까지가 방어의 일부다.

**규칙 2·2.7의 판정 단위** — 둘 다 원래 파일 단위였고 둘 다 뚫려 있었다.

- 규칙 2는 `action.batchPlay(` 형태만 봐서 `const { batchPlay } = action;`으로
  통과했다. 지금은 **이름이 나오는 것 자체**를 막는다(주석은 제외 — `stripComments`).
- 규칙 2.7의 왕복 면제는 파일에 `putPixels`가 한 번만 있으면 그 파일의 모든
  `getPixels`를 빼 줬다. 지금은 **함수 단위**다. 다만 **요구 사항은 파일 단위로**
  둔다 — 정규화·변환을 헬퍼로 빼는 것이 정상이라(`preview.js`) 같은 함수 안을
  요구하면 정상 코드를 막는다. 좁힌 것은 면제뿐이다.
- `colorSpace: "RGB"`는 **그 호출의 인자 안**을 본다. 함수 단위로 보면 같은 함수의
  다른 호출에 있는 것으로 통과한다 — 음성 테스트로 잡았다.

**양자화 규약** — 정수 버퍼로 나가는 자리는 **반드시 반올림한다**. 정수 타입 배열에
float을 대입하면 조용히 버려져 채널당 평균 −0.5LSB 편향이 생긴다. 양수 구간에서
`(v+0.5)|0`이 `Math.round`와 같고 훨씬 싸다 — `core/color/lut.js`와
`core/optics/tone.js`가 같은 규약을 쓴다.

**디더 표 길이는 소수(65537)다.** 2의 거듭제곱이면 이미지 폭과 인수를 공유해
행 주기로 잡음이 반복된다(폭 2048 → 32행). `check-tone.js`가 매번 재측정한다.

`tools/check-conformance.js`는 값이 아니라 **구조**도 본다 — "엔진 함수를 부르는 곳이
몇 군데인가"를 세어, 각 경로에 같은 변환을 복붙한 구조를 잡아낸다.

`tools/check-api.js`는 앱이 부르는 `모듈.함수()`가 **실제로 존재하는지** 본다.
`check-load`는 모듈 로드만 확인하고 호출까지는 보지 않아, `.cube`·프로파일 내보내기가
런타임에 죽고 있는 것을 오래 놓쳤다(→ [`RESOLVED.md`](./RESOLVED.md)).

> **검사는 일부러 깨뜨려 확인한다.** check-api를 만들 때 두 번 헛돌았고 둘 다
> **통과 표시를 내면서 아무것도 검사하지 않고 있었다.** 통과했다는 것이 검사가
> 실제로 돈다는 뜻은 아니다.

## 파이프라인

### 전체 순서

```
Camera Raw (중립 현상, ProPhoto 16bit)
   ↓
[엔진]  필름 → 스캐너 → 색 조정  →  3D LUT 한 장  →  putPixels
           "FilmSim Color · Color" 픽셀 레이어
   ↓
[마감]  그레이딩 → 디퓨전 → 할레이션 → 그레인
           "FilmSim Finish · …" 레이어들 → 그룹
```

**색 → 마감 순서는 강제다.** 마감의 디퓨전은 합성본을 구운 파괴적 스탬프라
역순으로 하면 색을 다시 입힐 수 없다(→ [`STATUS.md`](./STATUS.md) 알려진 한계).

### 「중립 현상」이 정확히 무엇인가 — **베이스의 정의**

위 그림 첫 칸의 "중립 현상"이 이 프로젝트 전체의 **기준점**이다. 여기가 흔들리면
아래 모든 수치가 같이 흔들린다. 오래 정의 없이 쓰였으므로 여기 못박는다.

`film.js`를 역산하면 요구 조건은 **두 개뿐**이다.

**(a) 18% 씬 그레이가 인코딩값 `0.3857`로 들어와야 한다.**
`H = log10(v^1.8 / 0.18)`이므로 `v = 0.18^(1/1.8) = 0.3857`일 때만 `H = 0`이다.
그 지점이 곧 TDS의 `Log H Ref`, 즉 "박스 스피드 정상 노광"이다. 어긋나면 곡선의
**다른 구간**을 쓰게 되어 발끝·어깨가 엉뚱한 자리에 걸린다.

**(b) 전달함수가 감마 1.8 거듭제곱 **하나뿐**이어야 한다.**
`L = v^1.8` 외에 다른 톤 매핑이 끼면 그 곡선이 **필름 곡선과 곱해진다.** 필름 대비를
재현하려고 만든 모델 앞에 정체불명의 S커브가 붙으면 재현이 성립하지 않는다.

> ⚠️ **Camera Raw의 기본값은 (b)를 만족하지 않는다.** 슬라이더를 전부 0으로 둬도
> 선형이 아니다 — 카메라 프로필(DCP)에 베이스라인 톤 커브가 들어 있고, 기본
> 프로필(`Adobe Color`)은 그 위에 대비를 더 건다. **"아무것도 안 건드린 현상"과
> "중립 현상"은 다르다.**
>
> 이 프로젝트는 같은 함정을 `.xmp` 경로에서 이미 한 번 밟았다 →
> [`RESOLVED.md`](./RESOLVED.md) "LrC — 필름 룩이 카메라 프로필 위에 덧입혀진다".
> 거기서는 `CameraProfile = "Adobe Standard"`를 강제해 바탕을 고정했는데,
> **Photoshop 경로(엔진 본체)에는 그런 고정이 없다.**

#### 검사 절차 — 말이 아니라 측정으로

두 조건을 각각 잰다. **(b)를 빼먹으면 안 된다** — (a)만 맞추면 S커브가 걸려 있어도
통과한다.

1. 18% 그레이 카드(또는 컬러체커 중간 패치)를 **정상 노출**로, 노출을 `-2 / -1 / 0 /
   +1 / +2`스톱으로 브래킷해 5장 찍는다.
2. 검사할 현상 설정으로 5장을 현상해 **ProPhoto 16bit**로 내보낸다.
3. 각 장에서 그레이 패치의 인코딩값 `v`를 읽는다(Photoshop 정보 패널, 0~255면 ÷255).
4. **(a)** 0스톱 장의 `v`가 **0.386 ± 0.005**(8bit로 98±1)여야 한다.
5. **(b)** `log2(v^1.8)`를 5장에 대해 구하면 **등간격 1.0씩**이어야 한다.
   편차가 0.05스톱을 넘으면 톤 커브가 걸려 있는 것이다.

4가 어긋나면 `film.js`의 `MID_GRAY_OFFSET`으로 **한 번만** 맞춘다(전역 상수다 —
필름마다 다른 값을 주면 감도 차이를 이중 적용하게 된다).
5가 어긋나면 오프셋으로 고칠 수 없다. 현상 설정을 바꿔야 한다.

#### 아직 검증되지 않았다

위 절차를 실제로 돌린 적이 없다. 그래서 `MID_GRAY_OFFSET = 0`이고, 거기 붙은 ⚠️
(ISO 측광 이론의 `8.1/S`와 TDS의 `14.4/S`가 0.25 log 어긋난다)는 **이 검사와 같은
문제**다 — "정답 스캔이 없다"의 정답 스캔이 곧 위 5장이다.
→ [`TODO.md`](../TODO.md) N1

#### 예외 — 로그 소스

`.cube` 내보내기에는 **입력 전달함수**를 갈아 끼우는 통로가 있다
(`core/io/cube.js`의 `INPUTS`, `film.buildForParams(params, size, {input})`).
Sony S-Log3을 고르면 위 (a)(b) 대신 **S-Log3 규약**이 기준이 된다 — 18% 그레이가
코드 `420/1023 = 0.41056`, 코드 1.0이 선형 38.4(+7.74스톱)다.

**화면·적용 경로는 이 통로를 쓰지 않는다.** 내보내기 전용이고, 기본값이면
`Math.pow(v, 1.8)` 그대로라 **비트 단위로 같다**(정합성 검사가 확인한다).

로그는 **이미 구운 LUT을 재격자하는 방식으로는 안 된다.** 엔진 LUT의 정의역이
선형 0~1뿐이라 S-Log3 코드 0.596 위(코드 범위의 **40%**, 하이라이트 4.4스톱)가
통째로 흰색으로 뭉갠다. 그래서 처음부터 그 전달함수로 굽는다. 원색
(S-Gamut3.Cine → ProPhoto)은 **선형 공간에서 3×3**으로 따로 옮긴다 — 행렬이 채널을
섞어서 축별 1차원 표를 못 쓰기 때문에 격자점마다 변환한다.

#### 엔진이 지키는 것 / 못 지키는 것

**지킨다** — 문서 색공간이 ProPhoto가 아니면 적용 시 경고한다
(`colorspace.workingSpaceCheck`, `apply.validate`). sRGB 문서는 기준 그레이가
+0.47스톱, 3스톱 아래 암부는 +0.75스톱 어긋난다고 수치로 알려 준다.

**못 지킨다** — 현상 **곡선**이 선형인지는 픽셀만 봐서 알 수 없다. 조건 (b)는
위 브래킷 검사로만 확인된다. 경고는 (a) 쪽 위험만 줄여 준다.

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
clearOwnLayers → grading.apply → grain.applyDiffusion → halation.apply → grain.applyGrain → 그룹화
```

**그레이딩이 제일 앞**이다 — 색을 확정하고 광학을 얹는 순서(전체 아키텍처와 같다).
할레이션이 조정된 하이라이트에서 발생해야 자연스럽다.

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
  "printGamma": 1.806,             // 1/γ_G. 인화지 "normalized"에서만 쓴다 (구 동작)
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
4. 인화             P = 10^(−paper(k − D))          k = 확대기 색 필터
5. 크로스토크 3×3
6. 스캐너 스테이지  레벨 → 틴트(3점) → S커브 → 채도   ← **옵션**. 기본 "none"
7. 화이트포인트     채널별 소프트 롤오프
```

**4단계가 메인 톤을 잡는다 — `core/color/paper.js`.** 네거티브는 확대기 빛을 막고,
인화지가 그것을 받아 포지티브를 만든다. 밝은 피사체 → 네거 농도 높음 → 인화 노광
적음 → 인화지 **발끝** → 밝은 인화물. 즉 **인화지 발끝이 하이라이트를, 어깨가 암부를**
만든다(7단계 롤오프가 흉내 내던 것이 발끝이다).

`k`는 채널별 인화 노광 = 확대기 색 필터다. 기준 그레이가 중성으로 인화되도록 잡는데,
이것이 오렌지 마스크를 상쇄한다 — 실제 인화에서 필터를 돌리는 그 작업이다.

| 인화지 | 감마 | 뜻 |
|---|---|---|
| `normalized` (기본) | 필름별 `1/γ_G` | v2.18까지의 동작. **필름 간 대비 차이가 지워진다** |
| `shared` | 공유 1.7066 | 필름 간 편차만 되살리는 중간 단계. ⚠️ 실측 아님 |
| `kodak-endura-premier` | 실측 곡선 γ 3.93~4.10 | RA-4 실측(E-4070). 발끝·어깨가 물리적으로 산다 |

**실측 곡선 인화지는 7단계 롤오프를 끈다.** 합성 롤오프는 "TDS 곡선에 어깨가 없다"를
메우려던 편법인데 인화지 발끝이 그 역할을 물리적으로 한다 — 둘 다 걸면 이중 압축이다
(Endura + Portra 400에서 흰색이 0.83 → 0.74로 더 눌렸다). 곡선 인화지는 출력이 구조적으로
`P = 10^(−Dp) ≤ 10^(−Dmin)`이라 원래 목적인 클리핑 방지도 필요 없다.

중성 회색의 **필름 간 폭**(8bit):

| 인화지 | 암부 10% | 기준 18% | 75% |
|---|---|---|---|
| `normalized` | 11 | 13 | 16 |
| `shared` | 17 | 15 | 50 |
| `kodak-endura-premier` | **31** | **21** | 22 |

인화지의 **Dmin이 흰색 상한을 정한다** — Endura는 0.079~0.104라 최대 반사율이
0.787~0.834다. 인화물의 흰색은 1.0이 아니라 종이 흰색이고, 층마다 달라 하이라이트가
아주 살짝 푸르다(청감층 Dmin이 가장 낮다). 실제 인화지가 그렇다.

인화지 곡선이 **직선이면 예전 수식과 대수적으로 같다** — 그래서 `normalized`는
v2.18과 비트 단위로 같고, `paper` 키가 없는 옛 프리셋도 그대로 동작한다.

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

### 마감 그레이딩 — `core/optics/tone.js`

```
채널 LUT: 선형광[노출 · 화이트밸런스] → 인코딩[흑점 → 대비 → 암부·명부]
          ↑ 입력값에만 의존하므로 (maxV+1)항목 테이블로 미리 굽는다
픽셀 루프: LUT 조회 ×3 → 채도·바이브런스 → fitGamut → TPDF 디더 → 양자화 (한 번만)
```

**채널 체인은 반드시 LUT으로 굽는다.** 픽셀마다 계산하면 `Math.pow`가 6번씩 들어가
24MP에서 4.4초가 걸렸다(테이블로 접은 뒤 0.88초, 5배). 디더 난수도 픽셀당 6번 뽑으면
그것만으로 1초가 넘어 **미리 구운 표**(2의 거듭제곱 길이, 비트 마스크로 순회)를 쓴다.

- **노출·색온도만 선형광**에서 한다(빛의 곱이라). 나머지는 인코딩 공간 — PS·Lightroom
  슬라이더와 기대가 맞는다. 감마는 문서 프로파일에서(ProPhoto 1.8, 그 외 2.2).
- **양자화는 마지막 한 번만.** 조정 레이어를 쌓으면 8bit 문서에서 단계마다 잘린다.
- **디더는 8bit에서만.** TPDF(균등난수 두 개의 차) ±1LSB. 실측 평균 띠폭 35.3px → 2.3px.
- ⚠️ **중간 단계에서 클램프하면 안 된다.** 인공 평탄부가 생기면 뒤의 채도 연산
  `L+(v−L)·s`가 그 구간에서 기울기 음수가 되어 **계조가 뒤집힌다**. 곡선은 클램프한
  값에만 먹이고 **초과분은 보존**한다. 범위 정리는 `fitGamut`이 마지막에 한 번.
- **완전 단조는 아니다.** `fitGamut`이 색역 경계에서 1레벨 뒤집힐 수 있다(0.04% 조합).
  하드 클립이면 단조롭지만 색상이 틀어진다 — 의도한 교환이다. 불변식은 "역전 ≤1레벨,
  빈도 <0.1%"로 잡는다.
- 프리셋 키는 `tone`이다. `grading`은 **엔진 스키마**라 migrate가 통과시킨다(충돌 금지).

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
