# Moderate's Film Simulator — Photoshop UXP 플러그인

디지털 사진에 아날로그 필름의 광학적·화학적 특성을 재현하는 포토샵 플러그인.

색은 눈대중이 아니라 **제조사 기술자료(TDS)의 D-logE 특성곡선에서 유도**한다.
층별 곡선 기울기의 차이가 필름마다 다른 색감의 정체이고, 그 수치를 그대로 쓴다.
결과는 3D LUT으로 구워 문서에 적용하거나, `.cube` · Lightroom 프로파일로 내보낸다.

> **v2.4.0** — 필름 9종(주광 8 + 텅스텐 Vision3 500T) · 실측 인화지(Kodak ENDURA
> Premier) · 다중스케일 광학 할레이션 · 값 노이즈 그레인 · 마감 그레이딩 · 피부톤
> 색역 · 분포 패널.
> 이번 판에 **「중립 현상」을 실측으로 검증**하고(Camera Raw는 조건을 못 만족함을
> 확인) `tools/decode-raw.py`(+ 데스크톱 GUI)로 리니어 현상 경로와 Sony S-Log3
> 입력을 추가했다. 고대비 장면용 **닷지·번**(실험적)도 새로 들어왔다.
> ⚠️ 스캐너 파라미터는 아직 튜닝값이다 → [현재 한계](#현재-한계)

## 두 개의 플러그인

| | **Engine** `com.filmsim.photoshop` | **Finish** `com.filmsim.finish` |
|---|---|---|
| 하는 일 | 필름 · 스캐너 · 노광 · 색 조정 | 할레이션 · 그레인 · 필름 포맷 |
| 산출 | 문서 적용 · `.cube` · Lightroom 프로파일 | 문서 적용 · 폴더 배치 |
| 입력 | 16bit RGB (ProPhoto 권장) | **8bit JPEG이 정상 입력** |

같은 문서에 겹쳐 쓰는 것이 정상이다. 레이어 접두사가 `FilmSim Color` / `FilmSim Finish`로
갈려 서로의 결과를 지우지 않는다. 하나만 설치해도 동작한다.

**왜 나눴나.** 색은 순수 계산이고 마감은 Photoshop 액션이다. 섞여 있으면 마감 쪽을
손보다 색이 망가질 수 있는데, 그 실수는 결과를 보기 전까지 드러나지 않는다. 나눠 두면
마감 플러그인에 색 코드가 **아예 들어 있지 않아** 물리적으로 불가능해진다.

## 설치

1. Photoshop 2023 (v24) 이상.
2. 최신 `.ccx`를 내려받는다 — 필요한 것만 받아도 된다.
   - [엔진(색) `com.filmsim.photoshop_PS.ccx`](https://github.com/Moder4te/moderates-film-simulator/releases/latest/download/com.filmsim.photoshop_PS.ccx)
   - [마감(할레이션·그레인) `com.filmsim.finish_PS.ccx`](https://github.com/Moder4te/moderates-film-simulator/releases/latest/download/com.filmsim.finish_PS.ccx)

   ([전체 릴리스](https://github.com/Moder4te/moderates-film-simulator/releases))
3. `.ccx`를 더블클릭한다. Adobe 플러그인 설치 관리자가 설치를 진행한다.
   "확인되지 않은 게시자" 경고가 나오면 허용한다(자체 서명).
4. Photoshop 재시작 → `플러그인` 메뉴에 **Film Sim 엔진** · **Film Sim 미리보기** ·
   **Film Sim 분포** · **Film Sim 마감**이 나타난다. 미리보기·분포 패널은 엔진 옆에
   도킹하면 된다(따로 띄워도 된다).

## 사용법

### 순서가 중요하다 — 색 먼저, 마감 나중

```
raw (중립 현상, ProPhoto 16bit)  →  엔진(색)  →  마감(할레이션·그레인)
```

**「중립 현상」은 정확한 뜻이 있다.** 엔진은 문서가 ProPhoto(γ1.8)이고, 입력의
전달함수가 **감마 1.8 거듭제곱 하나뿐**이라고 전제한다. 여기가 흔들리면 노광 기준과
암부가 함께 밀려 필름 곡선의 엉뚱한 구간을 쓰게 된다 — 필름 룩이 아니라 정체불명의
룩이 나온다. 문서 색공간이 ProPhoto가 아니면 적용 시 몇 스톱 어긋나는지 수치로 경고한다.

#### 공식 경로 — `tools/decode-raw.py`

raw를 톤 커브 없이 libraw로 직접 풀면 「중립 현상」 조건이 **구성상** 성립한다
(ACR을 아예 거치지 않으므로 잴 것도 없다).

```bash
pip install rawpy numpy tifffile
python tools/decode-raw.py in.ARW out.tiff        # 기본 헤드룸 +5스톱
```

좌표를 몰라 `--probe`가 번거로우면 **GUI**(`tools/decode-raw-gui.py`)로 미리보기를
클릭해서 잡을 수 있다 — `pip install ... pillow` 후 `python tools/decode-raw-gui.py`.
브래킷(같은 장면, 다른 스톱)을 한 번에 돌릴 때 특히 유용하다: 기준 프레임 하나에서만
측정하고 그 스케일을 배치 전체에 고정으로 건다. 사용법 → [`tools/README.md`](tools/README.md#decode-raw-guipy--데스크톱-gui).

출력 TIFF는 Photoshop에서 **프로파일 지정 → ProPhoto RGB**로 지정한 뒤, 엔진 패널의
**입력 소스**를 도구와 같은 헤드룸(「리니어 +5스톱」이 기본)으로 맞춘다. 어긋나면
노광이 통째로 밀린다. 그레이 카드가 있으면 `--probe x,y`로 기준 그레이 위치까지
그 자리에서 잡을 수 있고, 없으면 엔진 노출 슬라이더로 눈대중해도 된다(노광 기준
오차는 대수적으로 노출 보정과 상쇄된다). 정의와 절차는
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 「중립 현상이 정확히 무엇인가」 참조.

#### 더 쉬운 대안 — `acr-standard` 입력 (외부 도구 없음)

decode-raw.py를 안 거치고 **Camera Raw로 그냥 현상한 파일을 바로 먹이고 싶으면**,
엔진 패널의 입력 소스에서 **「ACR Adobe Standard (역산, 실험적)」**을 고른다.

⚠️ 실측(2026-08-12, Sony A7RV, "Adobe Color" Look을 뗀 순정 "Adobe Standard" 프로필
+ 슬라이더 전부 0)에서 암부 +0.62 / 명부 −0.24스톱의 대비 커브가 발견됐다 —
**이름과 달리 선형이 아니고, 오프셋 하나로 못 고치는 종류다.** `acr-standard`는
브래킷 실측으로 그 커브를 역산해 되돌린다(HDR 카메라 응답함수 복원과 같은 방법,
`tools/derive-acr-curve.py`). 왕복 검산으로 확인됨 → [`docs/RESOLVED.md`](docs/RESOLVED.md)
"ACR 'Adobe Standard' 톤 커브를 역산해 되돌리는 입력 추가".

**현상 조건은 정확히 맞춰야 한다** — Profile: Adobe Standard(Look 없음), 슬라이더
전부 0, ProPhoto RGB 16bit. 조건이 다르면(다른 프로필·슬라이더 조정) 역산이 안 맞는다.

⚠️ 이 곡선은 **Sony ILCE-7RM5 + ACR 18.3.2 한 세트에서 유도됐다** — 다른 카메라는
근사치다. 명암이 넓은 장면(±1.5스톱 밖)은 이 입력만으로 채도가 다 안 살아날 수
있다 — 그때는 닷지·번(엔진 패널의 실험적 옵션, 아래 [현재 한계](#현재-한계))을
같이 켠다(둘은 상호보완이지 대체가 아니다).
18% 그레이 카드로 잡는 절대 앵커(조건 (a))는 이쪽도 여전히 미확정이다 —
급하지 않다. 노출 슬라이더로 상쇄되기 때문이다.

기본(ProPhoto γ1.8) 입력으로 ACR 현상 파일을 그냥 먹이는 건 **여전히 권장하지
않는다** — 위 커브가 그대로 남아 필름 곡선과 곱해진다.

**마감을 먼저 얹으면 안 된다.** 마감의 디퓨전 레이어는 그 시점 화면을 구운 것이라,
그 뒤에 색을 적용하면 이미 구워진 픽셀을 다시 칠할 수 없다(색이 중복되거나 안 먹은
것처럼 보인다). 색을 확정한 뒤 마감을 얹는다.

작업 파일과 최종 출력 크기가 다르면 — **출력 크기로 리사이즈한 뒤 마감을 적용**하는
편이 간단하다. 그러지 않으려면 마감의 "입자 크기 기준"에 최종 긴 변을 직접 지정한다.

### 엔진 (색)

필름 · 스캐너 · 노광을 고르고 **[현재 문서에 적용]**. 컬러휠에서 대표색 마커를 끌어
색역별 CMY를 직접 조절할 수 있다. 미리보기 패널은 색만 반영한다(할레이션·그레인 제외).

**분포 패널**은 적용 결과의 색이 색상·채도 평면에 어떻게 퍼져 있는지 보여준다.
컬러휠과 각도 규약이 같아 나란히 읽힌다. 계측기가 아니라 분포 모양을 보는 용도다.

**필름 9종** — Portra 400/160/800 · Gold 200 · Ektar 100 · UltraMax 400 ·
Agfacolor Ultra 50 / Portrait XPS 160 · **Vision3 500T**(텅스텐).
**스캐너 2종** — Frontier · Noritsu. **노광 보정** ±2스톱.

> Vision3 500T는 CineStill 800T의 원본 필름이다. 마감의 `CineStill 800T` 프리셋과
> 함께 쓰면 텅스텐 색감 + 붉은 할레이션이 맞물린다.

### 마감 (할레이션 · 그레인)

**매체**(필름 포맷 · 입자 크기 기준) → **할레이션** → **그레인** 순으로 조절하고 적용한다.

- **그레인** — 크기를 **필름 감도(ISO 50~3200)** 로 받는다. 감도가 곧 입자 크기다.
  포맷(35mm~4×5)과 출력 해상도에서 실제 픽셀 크기가 물리적으로 계산된다.
- **할레이션** — 핫코어 · 미드(붉은 링) · 블리딩 세 스케일을 따로 조절한다.
  원반 슬라이더는 번짐의 경계를 무르게(0) 또는 뚜렷하게(100) 만든다.
- **프리셋** — `35mm Classic` · `Night Halation` · `120 Fine` · `CineStill 800T`

### 배치 적용 (마감)

- 출력 폴더를 원본 폴더와 다르게 지정해야 한다. 같으면 실행 전에 거부한다.
- 한 장이 실패해도 중단하지 않는다. 실패 목록은 완료 후 상태 표시줄에 나온다.
- **원본은 어떤 경우에도 수정되지 않는다** (`saveAs` + `asCopy`, 닫을 때 저장 안 함).

## 두 가지 모드

필름 카드의 체크박스가 모드 전환이다.

| | 필름 켬 — 색 | 필름 끔 — 마감 |
|---|---|---|
| 하는 일 | TDS 특성곡선으로 색을 정한다 | 색은 그대로 두고 할레이션·그레인을 얹는다 |
| 입력 | 16bit RGB (ProPhoto 권장) | **8bit JPEG이 정상 입력** |
| 쓰는 때 | raw에서 룩을 만들 때 | 이미 현상된 파일을 마감할 때 |

Lightroom 프로파일로 현상한 JPEG에 입자와 할레이션만 얹고 싶다면 **필름을 끄고** 쓴다.
그 상태에서는 8bit 경고가 뜨지 않는다.

## 내보내기

### `.cube` (3D LUT)

패널의 "LUT 내보내기" 카드. 내보낸 LUT은 "현재 문서에 적용"과 **같은 결과**를 낸다
(유제 → 스캐너 → 색 조정까지 전부 구워짐).

- **격자** 33³ / 65³. 33이 Photoshop·Camera Raw 표준, 65는 정밀도용.
- **입력 소스** 기본은 **엔진 기본(ProPhoto γ1.8)** — 사진용이고 "적용"과 같은 결과다.
  **Sony S-Log3 / S-Gamut3.Cine**을 고르면 로그 촬영본에 바로 거는 **룩 LUT**이 된다
  (로그가 들어가고 표시용 값이 나오는 비대칭 LUT이라 "적용"과 같은 결과가 아니다 —
  소스가 다르다). S-Log3 코드 1.0은 선형 38.4(+7.7스톱)라 하이라이트가 살아 있다.
- **출력 색공간** 사진은 **ProPhoto γ1.8** 그대로. 로그 입력에는 표시용이 필요하므로
  `Camera Raw`(ProPhoto 원색 + sRGB 톤 응답) 쪽이 실용적이다.
- **Photoshop에서 쓰기** — 조정 레이어 → 색상 검색 → 3DLUT 파일 → 로드.
  문서가 ProPhoto여야 한다. **GPU 가속 + 비파괴**라 대용량에서는 플러그인의 픽셀 적용보다 빠르다.

### Lightroom / Camera Raw 프로파일 (`.xmp`)

**"Lightroom 프로파일" 카드 → 입력 가정을 고르고 → 세트 전체.** 입력 가정은
두 가지 중 하나를 고른다 — **하이브리드(ACR 커브 그대로, 기본)**는 Camera Raw의
숨은 톤 커브를 되돌리지 않고 그 위에 필름 커브를 그대로 얹는다. **ACR
역산(톤 정확, 색 보류)**은 그 커브를 되돌려 톤은 더 정확하지만, ⚠️ 무채색
벽으로 유도해 색(카메라 프로필의 HueSatMap)은 안 돌아간다 — 채도 있는
피사체(피부·원색)에서 색이 틀어지고 계조가 깨질 수 있다(색차트로 재유도하기
전까지 보류, TODO N6). 채도 있는 사진은 하이브리드를 쓸 것. 고른 뒤 폴더를
지정하면 필름 × 스캐너 조합을 `.xmp`로 한 번에 쓴다. 아래 폴더에 복사하고
Lightroom을 재시작하면 끝이다.

```
Windows  %APPDATA%\Adobe\CameraRaw\Settings\
macOS    ~/Library/Application Support/Adobe/CameraRaw/Settings/
```

Profile Browser의 **FilmSim** 그룹에 뜨고 강도 슬라이더도 붙는다.
Lightroom · Lightroom Classic · Camera Raw 공통.

#### Lightroom Classic 플러그인으로 설치하기

프로파일 36종(필름 9 × 스캐너 2 × 입력 가정 2)을 담은 LrC 플러그인이 있다.
폴더를 직접 찾을 필요 없이 메뉴에서 설치한다. 하이브리드(ACR 커브 그대로)
변형은 필름 목록에 `(하이브리드)`가 붙은 별도 항목으로 뜬다 — 예:
"Portra 400"과 "Portra 400 (하이브리드)"를 각각 고를 수 있다.

Windows · macOS 공통이다.

1. 릴리스의 `FilmSim.lrplugin` 압축을 푼다
2. **파일 > 플러그인 관리자 > 추가** → 압축을 푼 **`FilmSim.lrplugin` 폴더 자체를 선택**
   (폴더 안으로 들어가 `Info.lua`를 고르는 것이 아니다. macOS에서는 이 폴더가 하나의
   묶음으로 보이므로 그대로 고르면 된다)
3. **라이브러리 > 플러그인 추가 기능 > 필름 프로파일 설치**
4. **Lightroom을 다시 시작한다** — 프로파일은 실행 시점에만 읽힌다

설치되는 위치. 직접 찾아갈 일은 없지만(설치 창의 **폴더 열기** 버튼이 열어 준다):

```
Windows  %APPDATA%\Adobe\CameraRaw\Settings\
macOS    ~/Library/Application Support/Adobe/CameraRaw/Settings/
```

> **macOS에서 폴더가 안 보인다면** `~/Library`가 Finder 기본 숨김이라 그렇다.
> Finder에서 `Cmd+Shift+G` 를 누르고 위 경로를 붙여 넣으면 들어갈 수 있다.
> 폴더가 아예 없으면 플러그인이 만든다.

그다음부터는 프로필 찾아보기를 뒤질 필요 없이 메뉴에서 바로 고른다.

**파일 > 플러그인 추가 기능 > 필름 룩 적용** — 필름과 스캐너 톤을 고르고 강도를
정하면 선택한 사진에 한 번에 들어간다. 기존 노출·크롭 조정은 그대로 둔다.
(라이브러리 모듈에서는 **라이브러리 > 플러그인 추가 기능**에도 같은 항목이 있다)

**카메라 프로필을 Adobe Standard로 맞춤** 체크는 켠 채로 두는 것이 기본이다.
카메라 프로필과 필름 룩은 별개 층이라, 끄면 사진에 이미 걸린 카메라 프로필
(예: `Camera BW`) **위에** 필름 룩이 덧입혀져 두 색이 섞인다.

⚠️ **ACR 역산** 변형은 **Adobe Standard + 슬라이더 전부 0**을 전제로 굽는다(→
[사용법](#순서가-중요하다--색-먼저-마감-나중)의 `acr-standard` 설명). 하이브리드
변형은 이 전제가 없다(애초에 ACR 커브를 되돌리지 않으므로). 이 기능은
"기존 노출·크롭 조정은 그대로 둔다" — 즉 **Basic 패널을 이미 만졌다면 그 조정이
남은 채로 필름 룩이 얹힌다.** 노출 정도는 대수적으로 상쇄되지만(조건 a), Contrast·
Highlights·Shadows·Whites·Blacks 같은 톤 조정을 이미 걸었다면 `acr-standard`의
전제가 깨져 정확도가 떨어진다 — 정확히 맞추려면 필름 룩을 적용하기 전에 그
슬라이더들을 0으로 되돌려 둔다.

> 이 플러그인은 **색을 계산하지 않는다.** 프로파일을 담아 옮겨 줄 뿐이다.
> LrC SDK는 픽셀에 접근할 수 없어(Develop 렌더링에 끼어들 방법이 없다) 필름 룩을
> 넣는 길이 프로파일뿐이고, 프로파일은 재시작해야 읽히므로 색 엔진을 Lua로 옮겨도
> 얻을 것이 없다. 저장소에서 직접 만들려면 `node tools/build-lrplugin.js`.

<details>
<summary><b>대안 — Camera Raw 대화상자로 .cube에서 만들기</b> (다른 앱에서도 .cube를 쓸 때)</summary>

1. Photoshop에서 **필터 → Camera Raw 필터** (`Shift+Ctrl+A`)
2. 오른쪽 아이콘 줄에서 **Presets**
3. **Alt(Option)를 누른 채** `+` 클릭 → "New Profile" 대화상자
4. 체크박스 전부 해제 → **Color Look-Up Table만 체크**
5. 색공간 드롭다운에서 **ProPhoto RGB** 선택
6. 내보낸 `.cube` 지정 → 이름 입력 → OK

> 5번 색공간을 틀리면 **검정이 뜨고 전체가 파르스름해진다.** 암부가 최대 1스톱 뜨고
> 18% 그레이의 색조가 웜에서 쿨로 뒤집힌다.

ACR 10.3 이상 필요. 직접 생성 쪽이 클릭 수도 적고 보간도 한 번 덜 거친다.
</details>

## 현재 한계

정직하게 적어 둔다. 전체 목록과 근거는 [`docs/STATUS.md`](./docs/STATUS.md).

- **스캐너 파라미터는 측정값이 아니다.** Frontier/Noritsu 값은 현상소 비교 문헌의
  정성 서술을 수치로 옮긴 튜닝값이다. 필름 룩의 상당 부분이 이 단계에서 나오므로,
  여기가 추정이면 결과물 전체가 추정이다.
- **적용은 비파괴가 아니다.** Photoshop이 batchPlay로 LUT 주입을 허용하지 않아 픽셀
  레이어로 적용한다. 비파괴가 필요하면 `.cube`를 내보내 Color Lookup에 수동 로드한다.
- **색 → 마감 순서를 지켜야 한다** (위 [사용법](#순서가-중요하다--색-먼저-마감-나중) 참조).
- **미리보기는 색만 보여준다.** 할레이션·그레인은 공간 연산이라 제외했다.
- **그레인 입자 크기가 필름별로 다르지 않다.** 포맷과 ISO로만 정해진다. 현행 Kodak TDS가
  입자 지표로 PGI를 쓰는데 구형 RMS granularity와 변환 관계가 없다고 명시해 뒀다.
- **엔진은 16bit 전제.** 32bpc에서는 Photoshop이 관련 기능을 비활성화한다.
- **Camera Raw로 직접 현상하는 경로는 실측상 중립이 아니다.** "Adobe Standard" +
  슬라이더 0으로도 암부 +0.62 / 명부 −0.24스톱의 대비 커브가 남는다(2026-08-12
  실측). `tools/decode-raw.py`(raw 직접 디코드)가 정확도 기준 공식 경로다 — 위
  [사용법](#순서가-중요하다--색-먼저-마감-나중) 참조. 18% 그레이 카드로 잡는
  절대 앵커(`MID_GRAY_OFFSET`)는 아직 미확정 — 노출 슬라이더로 상쇄되어 급하지 않다.
- **`acr-standard` 입력은 톤만 되돌리고 색은 안 돌린다 — 사용 보류.** 외부 도구
  없이 쓸 수 있는 대안으로 그 커브를 역산해 되돌리지만(2026-08-13), 무채색 벽으로
  유도해서 카메라 프로필의 색 변환(HueSatMap)은 그대로 남는다. 채도 있는 피사체
  (피부·원색)에서 색이 틀어지고 계조가 깨진다(2026-08-17 실사용 확인) — 색차트로
  재유도하기 전까지 채도 있는 사진에는 쓰지 말 것. 그때까지는 `decode-raw.py` 또는
  하이브리드(위 Lightroom 프로파일 절)를 쓴다. 카메라 종속이기도 하다 — Sony
  ILCE-7RM5 + ACR 18.3.2 한 세트로 유도됐다.
- **닷지·번은 실험적이고 기본값이 실기 미확정이다.** `limit=0.4`·`contrast=0.6`은
  실사진 한 장으로 고른 값이라 다른 장면·필름에서 안 맞을 수 있다(`TODO.md` N2).

## 개발

```bash
node tools/sync-libs.js   # 공유 층을 각 앱 lib/로 복사. core/를 고쳤으면 반드시
node tools/check.js       # 문법·경계·로드·정합성. 3초
```

UDT에서 `apps/engine/manifest.json` · `apps/finish/manifest.json`을 로드한다.
패키징:

```bash
uxp service start          # 별도 터미널. 떠 있어야 packaging이 된다
node tools/build-ccx.js
uxp service stop           # ⚠️ 반드시 끈다 — 켜져 있으면 UDT가 플러그인을 못 올린다
```

**문서는 [`DOCS.md`](./DOCS.md)에서 시작한다.** 구조·불변식은
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), 설계 근거는
[`docs/DECISIONS.md`](./docs/DECISIONS.md), UXP 함정은
[`docs/UXP-NOTES.md`](./docs/UXP-NOTES.md), 남은 작업은 [`TODO.md`](./TODO.md).

## 라이선스

**[PolyForm Noncommercial License 1.0.0](./LICENSE.md)** — 소스 공개, **비상업 용도만**.
개인·연구·교육·취미 등 비상업 목적으로 자유롭게 쓰고 수정·재배포할 수 있으나
상업적 이용은 허용되지 않는다.

- **제조사 TDS PDF는 재배포하지 않는다.** 저장소에는 그래프에서 추출한 수치 데이터만
  있고, 원본 PDF는 제외한다(`films.js`의 `source` 필드에 출처 기록).
- 스캐너 색·프로파일 등 외부 데이터는 상업 재배포를 막는 소스(GPL/NC 등)를 피해
  선택지를 열어 뒀다.

## 상표 고지 (Trademarks)

이 프로젝트에 등장하는 모든 제품명·필름명·브랜드명은 **각 소유자의 상표 또는
등록상표**다. 예: KODAK · PORTRA · EKTAR · GOLD · ULTRAMAX · VISION3 (Eastman
Kodak Company / Kodak Alaris), FUJIFILM · FRONTIER (Fujifilm), CINESTILL
(CineStill Film), NORITSU (Noritsu), AGFA (Agfa), ADOBE · PHOTOSHOP · LIGHTROOM ·
CAMERA RAW (Adobe Inc.).

- 이 프로젝트는 **비공식이며 위 어떤 회사와도 제휴·후원·보증 관계가 없다.**
- 상표는 오직 **재현 대상 필름·스캐너·소프트웨어를 식별하기 위한 지시적(명목적)
  사용**이다. 로고·서체·트레이드드레스는 쓰지 않는다.
- 이 플러그인의 결과물은 해당 실제 제품의 출력을 **정확히 재현한다고 주장하지
  않는다** — 공개 기술자료(TDS)에서 유도한 근사이며, 상표권자가 검증한 바 없다.
- 상표권자의 요청이 있으면 표기 방식을 조정한다.

> **면책.** 위 상표의 사용은 식별 목적의 명목적 사용에 한하며, 어떠한 제휴·보증도
> 의미하지 않는다. 소프트웨어는 [LICENSE.md](./LICENSE.md)에 따라 **어떠한 보증도
> 없이 있는 그대로** 제공되고, 저작자는 그 사용으로 인한 어떠한 손해에도 책임지지 않는다.
