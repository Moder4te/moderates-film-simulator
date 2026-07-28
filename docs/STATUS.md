# 현재 상태

> **성격: 동적.** 기능을 추가하거나 한계를 발견하면 갱신한다.
> 작업을 재개할 때 **가장 먼저 읽는 문서**다. "지금 무엇이 되고 무엇이 안 되는가"만 담는다.
> 구조는 [`ARCHITECTURE.md`](./ARCHITECTURE.md), 근거는 [`DECISIONS.md`](./DECISIONS.md).

## 버전

**여기에 숫자를 적지 않는다.** 한 번 적으면 반드시 낡는다 — 실제로 이 표가 릴리스
v2.0.0 · finish 2.15.0에 멈춰 있는 동안 코드는 v2.1.0 · 2.15.1이었다
(`DOCS.md` 갱신 규칙 1: 사실은 한 곳에만 적는다).

| | 진실인 곳 |
|---|---|
| 릴리스 | GitHub Releases · `README.md` 머리말 · `lrplugin/Info.lua` |
| 엔진 | `apps/engine/manifest.json` |
| 마감 | `apps/finish/manifest.json` |

두 플러그인은 독립 버전이다. 릴리스 태그 하나로 묶어 배포한다.
무엇이 언제 바뀌었는지는 아래 [최근 작업 흐름](#최근-작업-흐름-2026-07-28).

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
| 피부톤 색역 | ✅ | 색상각+채도 창. 피부 보호 · 전경색 스포이드 |
| 벡터스코프 | ✅ | **전용 패널**(Film Sim 분포). 밀도 격자 32×32, 적용 결과 기준 |

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
| 톤·색 그레이딩 | ✅ | 9슬라이더. 8bit 밴딩을 TPDF 디더로 처리 |
| 값 노이즈 그레인 | ✅ | 감도(ISO 50~3200) 기반, 포맷·해상도 물리 스케일 |
| 디퓨전 (번짐) | ✅ | 기본=변위(셀 단위 확산), 대안=블러 |
| 다중스케일 할레이션 | ✅ | Core/Mid/Bleed + 원반(Maximum) + DoG 채널차 |
| 존별 Blend If 마스킹 | ✅ | 암부/중간/명부 |
| 포맷 인지 (35mm~4×5) | ✅ | 그레인·할레이션 공유 |
| 배치 적용 | ✅ | 폴더 단위, 원본 미변경 |

**시드 프리셋** (`apps/finish/src/presets.js`) — 프리셋 폴더가 **비어 있을 때만** 심어진다:
`35mm Classic` · `Night Halation` · `120 Fine` · `CineStill 800T`

### Lightroom Classic 플러그인 — `lrplugin`

색을 계산하지 않는다. 엔진이 구운 `.xmp` 18종(필름 9 × 스캐너 2)을 담아 설치·적용만 한다.
이유는 `lrplugin/Info.lua` 주석 — SDK가 픽셀에 접근할 수 없고 프로파일은 실행 시점에만 읽힌다.

| 파일 | 하는 일 |
|---|---|
| `Install.lua` | 담긴 프로파일을 CameraRaw/Settings에 복사. 없으면 만들고, 실패 시 폴더 선택 |
| `Apply.lua` | 필름·스캐너 팝업 + 강도 + 바탕 프로필. 선택한 사진에 적용 |
| `Inspect.lua` | 현재 사진의 `Look`/`CameraProfile` 덤프 — 적용이 안 먹을 때 대조용 |
| `Profiles.lua` | **자동 생성** 카탈로그. SDK가 프로파일을 이름으로 조회 못 해서 필요 |

빌드: `node tools/build-lrplugin.js` → `dist/FilmSim.lrplugin/`.

**적용이 성립하는 조건 — 전부 실기에서 하나씩 밝혀졌다:**

| 넣는 것 | 없으면 |
|---|---|
| `Look.UUID` | 프로파일을 못 찾는다 |
| `Look.Parameters.RGBTable` | 이름·강도는 정상인데 **색만 안 걸린다** |
| `CameraProfile = "Adobe Standard"` | 기존 카메라 프로필 **위에 덧입혀져 색이 섞인다** |
| `LrTasks.pcall` (맨 `pcall` 금지) | 호출이 `Yielding is not allowed…`로 죽는다 |

UUID·RGBTable은 생성된 `.xmp`에서 **직접 뽑는다** — 따로 계산하면 파일과 어긋나 조용히
실패한다. 넘긴 값은 적용 후 **되읽어 대조**한다(넘긴 것과 남은 것은 다르다).

**빌드가 막는 것** — 카탈로그가 없는 파일 지목 / 필름×스캐너 격자 빈 칸 / Lua 파일 누락 /
두 메뉴 항목 불일치 / 두 조합이 같은 RGBTable(=색이 실제로 같다는 뜻).
`check.js`는 Lua의 BOM·인코딩·맨 `pcall`을 본다. **문법은 검사되지 않는다**(인터프리터 없음).

**Windows · macOS 공통 설계.** 갈라지는 지점과 처리:

| 지점 | 처리 |
|---|---|
| 설정 폴더 경로 | `home` + `WIN_ENV` 분기. `%APPDATA%\Adobe\CameraRaw\Settings` / `~/Library/Application Support/…` |
| 폴더가 없을 때 | **만든다.** 폴더 선택으로 넘기면 macOS는 `~/Library`가 숨김이라 막다른 길 |
| 폴더를 열어 보고 싶을 때 | 설치 완료 창의 **폴더 열기** → `LrShell.revealInShell` |
| 대화상자 치수 | 픽셀 대신 `LrView.share` · `width_in_chars`. macOS 기본 폰트가 더 넓어 고정 픽셀은 잘린다 |
| Inspect 덤프 | 알림창이 아니라 편집 필드. 복사해 가는 게 목적인데 macOS 알림은 긴 본문을 자른다 |
| 파일 이름 | `xmp.fileNameFor`가 ASCII만 남기고 `\/:*?"<>|` 제거 — 양쪽 파일시스템에서 안전 |

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

### 데이터 신뢰도

**전부 실측 표본이 있어야 풀린다** — 확보 경로가 없어 [`TODO.md`](../TODO.md)에서 **보류**로 두고
있다. 그때까지 추정값임을 코드 주석과 여기에 명시해 둔다.

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

- 엔진 재적용 시 레이어 격리·복원(`.visible` 토글, `.move`)
- 미리보기 격리가 undo 히스토리를 오염시키지 않는지
- **LrC — macOS는 실기 확인이 전혀 없다.** 위 플랫폼 표는 SDK 문서와 플랫폼 동작에
  근거한 설계지 검증된 결과가 아니다. Windows에서 통한 것이 그대로 통하리라 가정할 뿐이다.
- **LrC — 바탕 프로필 이름.** `Adobe Standard`가 없는 카메라에서 어떻게 되는지 못 봤다.
  Lightroom이 조용히 무시하면 색이 섞이는데, 그 경우를 감지해 알리는 코드는 넣었지만
  실제로 그 분기를 탄 적은 없다.

**LrC에서 실기로 확인된 것** — Windows 한정, 추측이 아니라 실제로 돈 것들이다:
플러그인 로드 · 메뉴 노출 · 프로파일 설치와 재시작 후 등장 · `applyDevelopSettings`로
`Look` 적용 · `Look.Parameters.RGBTable`이 색을 거는 키 · `CameraProfile`이 별개 층.

**실기에서 확인된 디스크립터** — 추측이 아니라 실제로 돈 것들이다:
`maximum`(원반) · `transform`(축소 피라미드) · `app.foregroundColor`(스포이드).

## 성능 (실기 체감)

| 단계 | 체감 | 비고 |
|---|---|---|
| 그레이딩 + 그레인 | 합쳐서 **5초 이내** | 24MP. tone을 LUT화해 4.4초 → 0.9초 |
| 할레이션 | 개선함 (v2.15) | 축소 피라미드로 비용 지표 약 11배 감소 |

**축소 피라미드** — 넓게 번지는 성분은 저주파라 낮은 해상도에서 계산해도 결과가 같다.
Core 1/1 · Mid 1/2 · Bleed 1/4. Core만 풀해상도인 이유는 **원반의 뚜렷한 경계**가
축소·확대에서 뭉개지기 때문이다.

## 최근 작업 흐름 (2026-07-28)

되짚을 필요가 있을 때만 본다. 상세는 [`RESOLVED.md`](./RESOLVED.md).

```
lrplugin      프로파일 배포 플러그인 (설치 + 필름·스캐너 선택 적용)
              macOS 대응 · 맨 pcall 제거 · RGBTable · 바탕 프로필
              → 적용까지 Windows 실기 확인. macOS 미확인
finish 2.7.0  그레인을 값 노이즈로 (블러 mush 해결)
       2.7.2  디퓨전 → 할레이션 → 그레인 순서 (할레이션 토글 가능)
       2.8.0  그레인 크기 → 감도(ISO)
       2.9~2.13  다중스케일 할레이션 (핫코어·미드·블리딩·원반)
       2.14   마감 그레이딩 (톤·색 9슬라이더 + TPDF 디더). 밴딩·감도 실기 확인됨
       2.15   할레이션 축소 피라미드 (비용 약 11배 감소)
       2.16.0 배치 원본 보호를 파일 단위로 · 재적용 시 그룹 안까지 재귀 삭제
              → 실기 **핵심 2건만 확인**(별칭 차단 · 1단 중첩 삭제).
                그룹 2단 중첩은 미확인 — guard 16이 충분한지 모른다
engine 2.8.0  피부톤 의사 색역 + 피부 보호 + 스포이드
       2.9.0  실시간 벡터스코프
       2.9.1  벡터스코프 전용 패널 + 밀도 정규화(p95) 수정
       2.9.4  벡터스코프 반경을 크로마로(필름룩에서 링이 차던 문제)
       2.10.0 .cube·프로파일 내보내기 복구 + 함수 호출 검사 추가
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
