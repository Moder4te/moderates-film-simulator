# 현재 상태

> **성격: 동적.** 기능을 추가하거나 한계를 발견하면 갱신한다.
> 작업을 재개할 때 **가장 먼저 읽는 문서**다. "지금 무엇이 되고 무엇이 안 되는가"만 담는다.
> 구조는 [`ARCHITECTURE.md`](./ARCHITECTURE.md), 근거는 [`DECISIONS.md`](./DECISIONS.md).

## 버전

| | 버전 | 위치 |
|---|---|---|
| 릴리스 | **v2.0.0** (정식, Latest) | GitHub Releases |
| 엔진 | engine **2.7.4** | `apps/engine/manifest.json` |
| 마감 | finish **2.13.1** | `apps/finish/manifest.json` |

두 플러그인은 독립 버전이다. 릴리스 태그 하나로 묶어 배포한다.

## 동작하는 것

### 엔진 (색) — `apps/engine`

| 기능 | 상태 | 비고 |
|---|---|---|
| TDS 특성곡선 → 3D LUT | ✅ | 사면체 보간, 항등 오차 0 |
| 문서 적용 (putPixels) | ✅ | 60.2MP 3.4초 |
| `.cube` 내보내기 | ✅ | 33³/65³, ProPhoto γ1.8 |
| Lightroom/ACR 프로파일(.xmp) | ✅ | 직접 생성. Difference 판정상 일치 |
| 스캐너 스테이지 | ✅ | Frontier / Noritsu ⚠️ 튜닝값 |
| 노광 보정 | ✅ | ±2스톱 |
| 실시간 미리보기 | ✅ | 프록시 300px, 색만 |
| 컬러휠 편집 | ✅ | 마커 드래그 + 무채색 미니휠 |

**필름 9종** (`core/color/films.js`) — 전부 color-negative, TDS 벡터 추출:

| ID | 이름 | ISO | 밸런스 |
|---|---|---|---|
| `agfa-ultra-50` | Agfacolor Ultra 50 | 50 | daylight |
| `agfa-portrait-xps-160` | Agfacolor Portrait XPS 160 | 160 | daylight |
| `kodak-ektar-100` | Ektar 100 | 100 | daylight |
| `kodak-portra-160` | Portra 160 | 160 | daylight |
| `kodak-portra-400` | Portra 400 | 400 | daylight |
| `kodak-portra-800` | Portra 800 | 800 | daylight |
| `kodak-ultramax-400` | UltraMax 400 | 400 | daylight |
| `kodak-gold-200` | Gold 200 | 200 | daylight |
| `kodak-vision3-500t` | **Vision3 500T** | 500 | **tungsten** |

### 마감 (광학) — `apps/finish`

| 기능 | 상태 | 비고 |
|---|---|---|
| 값 노이즈 그레인 | ✅ | 감도(ISO 50~3200) 기반, 포맷·해상도 물리 스케일 |
| 디퓨전 (번짐) | ✅ | 기본=변위(셀 단위 확산), 대안=블러 |
| 다중스케일 할레이션 | ✅ | Core/Mid/Bleed + 원반(Maximum) + DoG 채널차 |
| 존별 Blend If 마스킹 | ✅ | 암부/중간/명부 |
| 포맷 인지 (35mm~4×5) | ✅ | 그레인·할레이션 공유 |
| 배치 적용 | ✅ | 폴더 단위, 원본 미변경 |

**시드 프리셋** (`apps/finish/src/presets.js`) — 프리셋 폴더가 **비어 있을 때만** 심어진다:
`35mm Classic` · `Night Halation` · `120 Fine` · `CineStill 800T`

## 알려진 한계

### 설계상 남겨둔 것

- **적용 순서는 색 → 마감이어야 한다.** 마감의 디퓨전 레이어는 그 시점 합성본을 구운
  **파괴적 스탬프**라, 마감을 먼저 얹은 뒤 엔진을 적용하면 그 픽셀은 다시 색을 입힐 수
  없다(중복 또는 미적용). 엔진이 재적용 시 FilmSim 레이어를 격리해 중복 자체는 막지만,
  이미 구워진 픽셀은 되돌리지 못한다. → `apps/engine/src/apply.js` 주석
- **적용은 비파괴가 아니다.** batchPlay로 Color Lookup에 LUT을 주입하는 경로가 막혀
  픽셀 레이어로 적용한다. 비파괴가 필요하면 `.cube`를 내보내 수동 로드.
- **엔진은 16bit 전제.** 32bpc에서 Photoshop이 Selective Color 등을 비활성화한다.
  (마감은 8bit JPEG이 정상 입력)
- **미리보기는 색만.** 할레이션·그레인은 공간 연산이라 제외. 마감 플러그인에는
  미리보기 패널 자체가 없다.

### 데이터 신뢰도 (→ [`TODO.md`](../TODO.md) A 항목)

- **스캐너 파라미터는 측정값이 아니다.** Frontier/Noritsu 값은 현상소 비교 문헌의
  정성 서술을 수치로 옮긴 튜닝값. → `core/color/scanner.js`
- **텅스텐 캐스트는 추정값.** 500T의 `tungstenCast {r:-0.04, g:0.08, b:0.06}`은
  주광 무보정 근사이고 실기 눈으로 맞춘 값이다. → `core/color/films.js`
- **중간 그레이 앵커 오프셋이 0으로 박혀 있다.** 기준 스캔이 없어 추정값을 넣지 않았다.
  → `core/color/film.js` `MID_GRAY_OFFSET`
- **그레인 µm 대응은 추정.** 현행 Kodak TDS는 PGI를 쓰고 구형 RMS granularity와
  변환 관계가 없다고 명시. `micronsForIso`는 감성 근사.
- **유효 입자 크기가 필름별로 다르지 않다.** 포맷과 ISO로만 정해진다.
- **스캐너 광도 계수가 원색과 어긋난다.** Rec.709 계수인데 데이터는 ProPhoto 원색.
  영향 실측함(최대 4/255). 재튜닝과 묶어서 처리 예정.

### 실기 검증이 필요한 것

정적 검사로는 확인할 수 없다 — batchPlay/DOM 동작은 Photoshop에서만 드러난다.

- 할레이션 원반(`ps.maximumFilter`) 디스크립터 동작 — 실패 시 원반 0으로 폴백
- 엔진 재적용 시 레이어 격리·복원(`.visible` 토글, `.move`)
- 미리보기 격리가 undo 히스토리를 오염시키지 않는지

## 최근 작업 흐름 (2026-07-27)

되짚을 필요가 있을 때만 본다. 상세는 [`RESOLVED.md`](./RESOLVED.md).

```
finish 2.7.0  그레인을 값 노이즈로 (블러 mush 해결)
       2.7.2  디퓨전 → 할레이션 → 그레인 순서 (할레이션 토글 가능)
       2.8.0  그레인 크기 → 감도(ISO)
       2.9~2.13  다중스케일 할레이션 (핫코어·미드·블리딩·원반)
engine 2.7.0  Vision3 500T + 텅스텐 밸런스
       2.7.3  색 재적용 중복 방지 + 정적 회귀 가드
       2.7.4  미리보기 중복 표시 수정
v2.0.0 정식 릴리스 · PolyForm Noncommercial 라이선스
```

## 작업 재개 체크리스트

```bash
git log --oneline -5
node tools/sync-libs.js      # core/ 를 고쳤으면 반드시
node tools/check.js          # 문법·경계·로드·정합성. 3초
```

실기: Photoshop 실행 → UDT에서 `apps/engine/manifest.json`, `apps/finish/manifest.json` 로드.

| 막히는 증상 | 원인 |
|---|---|
| `Cannot read property 'loadPlugin' of undefined` | `uxp service`가 포트 14001 점유. 끄고 UDT 재시작 |
| 엔진만 로드 실패 | 설치판 `com.filmsim.photoshop`과 ID 충돌. 설치판 제거 |
| 앱이 `core`를 못 찾음 | `sync-libs.js`를 안 돌렸다 |
| `host is in a modal state` | 미리보기/적용 모달 중 리로드. 잠깐 기다렸다 재시도 |
