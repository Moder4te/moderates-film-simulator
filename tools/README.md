# tools/

빌드 시점 도구. 플러그인 런타임에는 포함되지 않는다.

## measure-scan.js · decode-arq.py

`docs/PLAN-GRAIN-2026-08-02.md` M1. 필름 스캔에서 그레인 통계(채널별 RMS·
상관길이·채널 간 상관·센서 잡음 차감)를 뽑아, `grainfield`가 만드는 합성
필드와 같은 숫자로 맞춰 본다.

RAW 디코딩(rawpy)과 측정(의존성 0인 순수 JS)을 분리했다 — `extract_tds_curves.py`와
같은 이유다.

```
pip install rawpy numpy
python tools/decode-arq.py scan.ARQ scan.ppm
node tools/measure-scan.js scan.ppm scan2.ppm --patch <cy>,<cx> [--size 512] [--sigma 8] [--out out.json]
```

- `scan.ppm`만 주면 자기상관(단일 패치)만 나온다. **두 번째 PPM(같은 자리 재촬영)을
  주면** 센서 잡음을 구적으로 빼고, 자기상관 대신 **프레임 간 교차상관**으로 상관길이를
  잰다 — 독립인 두 프레임의 센서 잡음이 0-lag에서 자동으로 빠져 자기상관보다 훨씬
  안정적이다(2026-08-02 실측: 자기상관 1~2px → 교차상관 6px, 계획서 기대치와 일치)
- `--patch`는 **균일 노출 구간**(그레인만 있고 실제 피사체 디테일이 없는 자리)을 줘야
  한다. 프레임 중앙이 아니라 하늘·벽처럼 평탄한 자리를 눈으로 골라서 좌표를 넣는다 —
  실측 디테일이 섞이면 채널 간 상관이 크게 오염된다(중앙 크롭으로 재봤다가 상관
  0.5~0.7이 나온 전례가 있다. 실제로는 ≈0이어야 정상)
- `--size`는 2의 거듭제곱이어야 한다(FFT)
- `psf`는 퍼포레이션 엣지로 잰 간이 슬랜티드 엣지 근사다(ISO 12233 풀 SFR 아님).
  G2(채널 간 크기 비교)에만 쓴다 — 밀도 단계 간·필름 간 비교는 보정이 필요 없다
- ⚠️ **`sensorNoise`는 상한값이다.** 손 초점 + 리그 촬영이라 컴포짓(16샷) 내부 진동을
  완전히 못 없앤다 — 서브픽셀로 정렬해도 차영상 잡음이 5~8%만 줄어든다. 그레인
  진폭비가 실제보다 낮게 나올 수 있다(보수적 방향)
- ⚠️ `sizeRatio.caCorrected`가 PSF sigma와 상관길이가 비슷한 자릿수일 때 0으로
  무너질 수 있다 — 버그가 아니라 그 채널·패치에서 광학 흐림이 그레인 덩어리 크기와
  같거나 커서 구적 보정의 물리적 한계에 닿았다는 뜻이다(계획서의 "측정한 상관길이는
  실제 크기가 아니라 그 상한" 경고와 같은 현상)

## decode-raw.py

RAW를 **톤 커브 없는 ProPhoto 16bit**로 푼다. 엔진 베이스의 조건 (b)를 측정이 아니라
**구성으로** 만족시키는 길이다(→ [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
「중립 현상이 정확히 무엇인가」).

```
pip install rawpy numpy tifffile

python tools/decode-raw.py --selftest                      # raw 없이 성질 검산
python tools/decode-raw.py in.ARW out.tiff                 # 스케일 없이(엔진 노출로 맞춤)
python tools/decode-raw.py in.ARW out.tiff --probe 2400,1600,128
python tools/decode-raw.py in.ARW out.tiff --midgray 0.118 -h 5
```

- `--probe x,y[,size]` 그레이 카드(또는 아는 중성 패치) 중심을 찍으면 거기를 헤드룸
  자리에 **정확히** 놓는다. `--midgray`는 그 값을 직접 줄 때
- **둘 다 없으면 스케일을 안 건다.** 기준 그레이가 어디 있는지 모르니 추정하지 않는다 —
  경고를 찍고 화이트 레벨 기준 선형 그대로 낸다. 엔진 노출 슬라이더로 맞추면 되고,
  조건 (a)는 그것으로 완전히 상쇄된다
- `-h 4|5|6` 헤드룸(기본 5). ⚠️ **패널의 입력 소스를 같은 값으로 맞출 것** —
  도구가 끝에 무엇을 고르라고 찍어 준다
- ⚠️ **ICC를 안 박는다.** Photoshop에서 **프로파일 지정 → ProPhoto RGB**를 해야 한다
- ⚠️ **눈으로 보면 어둡다**(기준 그레이 8bit 37). 보는 파일이 아니라 먹이는 파일이다

TIFF 쓰기는 `tifffile`에 맡긴다. 손으로 IFD를 조립해 봤더니 PIL이 열기는 하면서 픽셀은
8비트로 잘라 읽었고, **파일이 틀렸는지 리더가 부족한지 구분할 수 없었다.** 포맷은
검증된 라이브러리에, 이 도구는 값이 맞는지에만 책임진다.

## extract_tds_curves.py

제조사 TDS PDF에서 필름 특성곡선(D-logE)을 추출해 JSON으로 내보낸다.
`src/films.js`의 `characteristicCurves` 데이터가 여기서 나온다.

Kodak TDS의 특성곡선은 **래스터가 아니라 벡터 경로**다(이미지 XObject 0개).
그래서 그래프를 눈으로 디지타이징하지 않고 좌표를 그대로 읽는다 — 재현 가능하고
정밀하다. 실측 정확도는 독립 시각 판독 4건 대비 농도 0.01 이내였다.

### 사용

```
pip install pymupdf

python tools/extract_tds_curves.py <pdf> <페이지> <x0> <y0> <x1> <y1> [negative|reversal|paper] > out.json
```

뒤의 네 숫자는 특성곡선 플롯을 감싸는 대략적인 영역(PDF 포인트 단위)이다.
넉넉하게 줘도 되지만, 같은 페이지의 다른 차트(분광감도 등)를 통째로 포함하면
프레임을 잘못 잡을 수 있다.

마지막 인자는 층 순서 불변식(컬러 네거티브는 B > G > R)을 적용할지 정한다.
**리버설과 RA-4 인화지는 오렌지 마스크가 없어** 그 순서가 보장되지 않으므로
반드시 종류를 넘겨야 한다 — 안 넘기면 멀쩡한 추출이 거부된다.

예시 (검증된 두 필름):

```
python tools/extract_tds_curves.py portra400_E4050.pdf 4 70 90 280 300 > portra.json
python tools/extract_tds_curves.py gold200_E7022.pdf   4 60 90 330 330 > gold.json
```

### 출력에서 반드시 확인할 것

- `axisTickCheck` — 축 보정 잔차. 검증된 두 필름은 0.001 단위 이하였다.
  값이 크면 최외곽 라벨이 프레임 모서리에 없는 플롯일 수 있다.
- `labelMatchMargin` — R/G/B 라벨 배정의 여유(pt). 작으면 층이 뒤바뀌기 쉽다는
  뜻이다. Gold 200의 G가 4.54로 가장 빠듯했다.
- `subpathBreaks` / `xBacktracks` / `droppedPoints` — 0이 아니면 stderr에도
  경고가 뜬다. 곡선이 끊겼거나 되돌아간다는 뜻이므로 원본을 눈으로 확인할 것.
- `clippedAtFrame` — 곡선이 프레임 가장자리에서 잘렸다는 표시. 그 끝점 농도는
  Dmin이 **아니다**. Gold 200이 이 경우다.
- **stderr 경고가 하나라도 있으면 결과를 믿지 말 것.**

### 알려진 함정 (전부 실제로 밟은 것)

| 함정 | 대응 |
|---|---|
| y축 `0.0` 라벨이 프레임 하단선과 겹쳐 x축 라벨로도 잡힘 | 라벨 경계상자로 판별 |
| 같은 페이지 분광감도 차트의 파장 라벨(350~750)이 x축에 섞임 | 프레임 바로 아래 25pt로 탐색 제한 |
| Gold는 음수를 **숫자 위 가로줄(오버바)**로 조판 — 텍스트에 부호가 없음 | 오버바 획을 벡터에서 직접 판독 |
| 부호 복원을 단조 휴리스틱으로 하면 축이 전부 음수일 때 조용히 틀림 | 오버바 우선, 폴백 시 stderr 경고 |
| 프레임이 선분 4개(Portra)일 수도, 사각형 하나(Gold)일 수도 있음 | 곡선을 먼저 찾고 감싸는 최소 상자를 선택 |
| 곡선의 평평한 끝이 축 눈금으로 오인됨 | 눈금 검산에서 곡선 경로 제외 |
| 라벨 중심으로 축을 보정하면 1.07% 틀림 | 프레임 + 눈금 사용 (마이너스 글리프가 중심을 밀어냄) |

### 검증 방법

새 필름을 추출했으면 다음을 확인한다.

1. 플롯을 이미지로 렌더해 눈으로 값 몇 개를 읽고 대조한다.
2. 곡선에서 ISO를 역산해 공칭값과 맞는지 본다. 검증된 두 필름은
   Portra 399.5(공칭 400), Gold 207.2(공칭 200)로 나왔다.
3. `Log H Ref = log10(14.4 / ISO)`가 성립하는지 확인한다. Kodak 5종에서
   편차 0.022스톱 이내로 성립한다(v2plan.md 4.3 참조).
4. **제3자 독립 추출본이 있으면 대조한다.** 1~3은 전부 자체 검증이라 같은 실수를
   같은 방식으로 하면 못 잡는다. 같은 데이터시트를 독립적으로 추출한 프로젝트와
   맞춰 보면 그 사각이 사라진다 — 실제로 [spektrafilm](https://github.com/andreavolpato/spektrafilm)과
   7종을 대조해 6종 일치를 확인했다(잔차 RMS 0.043~0.049 D).
   **비교는 최종 이미지가 아니라 특성곡선끼리** 한다 — 모델이 다르면 결과 차이가
   데이터 탓인지 모델 탓인지 갈리지 않는다. H=0에서 정규화하면 채널별 절대 오프셋
   (오렌지 마스크 등)이 상쇄돼 모양만 남는다.
   ⚠️ **라이선스를 먼저 본다.** spektrafilm 프로파일은 CC BY-SA 4.0이라 이 저장소
   (PolyForm NC)에 **편입할 수 없다.** 읽고 대조 결과만 기록한다.

## extract_tds_spectral.py · derive-tungsten-cast.py · derive-crosstalk.py

같은 TDS의 **분광** 도면에서 값을 뽑는다. 특성곡선은 "필름 + 3200K 노광 + Status M
농도"라는 한 세트라 파장 정보가 이미 적분돼 사라진 뒤인데, 분광 도면에는 남아 있다.
그래서 광원을 바꾸거나(→ `tungstenCast`) 염료 간 누설을 계산할(→ `crosstalk`) 수 있다.

```
python tools/extract_tds_spectral.py <pdf> <페이지> <x0> <y0> <x1> <y1> sensitivity > sens.json
python tools/extract_tds_spectral.py <pdf> <페이지> <x0> <y0> <x1> <y1> dye --assign-by-peak > dye.json
python tools/derive-tungsten-cast.py sens.json [--extrapolate] [--selftest]
python tools/derive-crosstalk.py     dye.json  [--bands R,G,B]
```

Vision3 500T(`H-1-5219t`) 4쪽 실제 인자:

```
python tools/extract_tds_spectral.py H-1-5219t.pdf 4 335  40 570 235 sensitivity
python tools/extract_tds_spectral.py H-1-5219t.pdf 4 320 335 570 556 dye --assign-by-peak
```

추출 결과는 `tools/tds-spectral/*.json`으로 저장소에 넣는다 — **PDF 없이 유도를
재현할 수 있다.** (PDF 자체는 `.gitignore`의 `tools/tds/`로 계속 제외한다.)

### 특성곡선 추출기와 다른 점

| | 특성곡선 | 분광 |
|---|---|---|
| 곡선 자르기 | 서브패스 간격 중앙값 배수 | **x 되돌아감**(파장은 단일값 함수라 오검출이 없다) |
| 곡선 잇기 | 없음 | 끝점 일치(0.15pt)로 체인 — 한 곡선이 벡터 경로 4개에 걸쳐 있다 |
| 축 보정 | 프레임 못박기 + 눈금 검산 | **라벨 최소제곱 회귀**(프레임은 획 굵기만큼 밖에 있다 — 감도 도면에서 1.6nm) |
| 불변식 | 컬러 네거티브 농도 B>G>R | **피크 파장 옐로 < 마젠타 < 시안** |

### 출력에서 반드시 확인할 것

- `axisFit.*.maxResidual` — 축 회귀 잔차. 감도 도면 0.74nm / 0.009 log, 염료 도면
  3.2nm(라벨 조판이 성기다)였다.
- `labelDisagreement` — **비어 있지 않으면 도면의 이름이 물리와 어긋난다는 뜻이다.**
  `H-1-5219t`의 염료 도면은 Cyan과 Yellow가 뒤바뀌어 인쇄돼 있다
  (→ [`docs/RESOLVED.md`](../docs/RESOLVED.md) "TDS 도면이 염료 이름을 뒤바꿔 인쇄했다").
  `--assign-by-peak` 없이 돌리면 불변식이 **추출을 중단**시킨다 — 조용히 고치지 않는다.
- `tailBound`(유도기) — 곡선이 끊긴 지점의 감도가 피크 대비 얼마인가. 500T는 적감층
  0.17로 커 보이지만, `--extrapolate`로 재적분해도 결과가 0.003 log 안에서 같다.

### 검산

- `derive-tungsten-cast.py --selftest` — 내장 CIE 주광 구현을 colour-science와 대조
  (`pip install colour-science`, 없으면 건너뛴다). 최대 상대편차 0.008%.
- 유도한 캐스트의 b−r은 그 필름의 보정 필터(Wratten 85)의 농도 프로파일과 **부호만
  반대**여야 한다. TDS 1쪽의 EI(텅스텐/주광)도 같은 방향으로 맞아야 한다.
- ⚠️ `derive-crosstalk.py`는 Status M 분광 응답도(ISO 7589)가 없어 밴드를 **대표 파장
  한 점**으로 근사한다. `--bands`로 ±15nm 흔들어 비대각이 얼마나 움직이는지 보고
  결론에 그 폭을 적을 것.
