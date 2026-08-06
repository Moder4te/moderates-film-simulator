# TDS 자료 목록

수집 64건 전부 다운로드 성공. 각 PDF를 열어 특성곡선 페이지를 찾고, 곡선이 벡터인지·축 라벨이 텍스트인지 자동 판정한 결과다.

> PDF 자체는 저작물이라 저장소에 넣지 않는다(`.gitignore`의 `tools/tds/`).
> 여기서 추출한 **수치 데이터만** `src/films.js`에 담는다.

## 먼저 읽을 것

**등급 B가 "어렵다"는 뜻이 아니다.** 자동 영역 탐색이 Kodak 컬러 네거티브
레이아웃에만 맞춰져 있어서 그 밖은 전부 B로 떨어졌을 뿐이다. B는 플롯을 감싸는
좌표 네 개를 손으로 주면 A와 똑같이 추출된다. 문서당 몇 분이다.

**리버설(슬라이드) 필름은 지금 엔진으로 못 쓴다.** `film.js`는 네거티브를
전제한다 — 노광이 늘면 농도가 오르고, 그것을 인화 감마로 반전시킨다. 리버설은
반대로 노광이 늘수록 농도가 **내려간다**. 곡선을 넣어도 결과가 뒤집힌다.
슬라이드를 쓰려면 4단계(반전/인화)를 필름 타입별로 분기해야 하고, 그건 엔진
변경이다. 목록에는 넣었지만 **선택 시 이 비용을 감안할 것.**

**흑백도 마찬가지다.** D2에서 "일단 컬러부터"로 정했고, 흑백은 층이 하나라
크로스토크·층별 감마가 의미를 잃는다. 단일 채널 경로가 따로 필요하다.

| 등급 | 뜻 |
|---|---|
| **A** | 자동 추출 확인됨 — 바로 쓸 수 있다 |
| **B** | 곡선·축 라벨 모두 벡터. **플롯 영역만 지정**하면 추출된다 |
| **C** | 곡선은 벡터지만 **축 숫자가 아웃라인**이라 축 값을 손으로 넣어야 한다 |
| **D** | 스캔 이미지이거나 벡터 곡선 없음 — 추출 불가 |

## 수집 중 알아낸 것

**1. Agfacolor Ultra 50의 특성곡선을 찾았다.**
v2plan de-risk에 "Agfa Ultra는 단종된 지 오래라 TDS 확보가 불확실"로 남겨뒀던
항목이다. `Agfa Professional Films`(1998) 8쪽에 **Portrait XPS 160과 함께**
실려 있다. Agfa 자신이 색채도를 `Extremely high`로 분류한다 — 목록에서 가장
극단적인 발색으로 표기된 필름이다.

**2. Agfa는 RMS 그래뉼래러티를 발행한다.**
최신 Kodak TDS는 RMS를 버리고 Print Grain Index로 갈아탔고, PGI는 µm 단위
입자 크기로 환산할 수 없다(v2plan 4.2). Agfa 문서는 5쪽에서 RMS 측정법을
설명한다. **v2plan 4.5의 물리적 입자 크기 유도가 Agfa 필름에서는 되살아난다.**
Agfa 한 종으로 절대 크기를 보정하고 나머지를 PGI 비로 스케일하면, 4.5에서
"한 점 보정"이라 적었던 그 기준점이 생긴다.

**3. Fuji Pro 계열은 축 숫자가 벡터 아웃라인이다.**
Pro 400H·160S·160C·800Z·Superia Reala·Sensia 200/400이 그렇다. 곡선 자체는
깨끗한 벡터인데 축 눈금 숫자만 글자가 아니라 도형이라, 좌표 변환 기준을 자동으로
읽을 수 없다. 축 최소/최대값을 눈으로 읽어 인자로 넘기는 방식이면 쓸 수 있다.
**Reala와 Pro 400H가 여기 걸린 것이 아깝다** — 둘 다 색감으로 이름난 단종 필름이다.

**4. `Log H Ref = log10(14.4 / ISO)`가 6종에서 재확인됐다.**
Ektar 100 −0.84 / Portra 160 −1.051 / Gold 200 −1.14 / Portra 400 −1.44 /
UltraMax 400 −1.44 / Portra 800 −1.74. UltraMax 400이 Portra 400과 같은 값인
것도 ISO가 같으니 정합한다. 이 관계 덕에 **필름이 몇 종이 되든 감도 차이가
밝기 차이로 새지 않고 곡선 형태 차이만 남는다.**


## RA-4 인화지 (2026-08-06 추가)

필름 TDS에는 인화지 응답이 없지만 **인화지 TDS에는 있다.** 모든 필름이 같은 인화지에
인화되므로 인화지 감마는 필름과 무관한 공유 상수이고, 그것이 `core/color/paper.js`의
메인 톤이다(왜 중요한지는 그 파일 헤더).

| 인화지 | 제조사 | 상태 | 등급 | 곡선쪽 | 비고 |
|---|---|---|---|---|---|
| ENDURA Premier | Kodak Alaris | 채택 | **A** | E-4070 p4 | RA-4, Status A. γ R3.98/G3.93/B4.10 |
| Crystal Archive Deep Matte Velvet | Fujifilm | 불가 | — | — | 특성곡선 없음. 분광 곡선도 래스터 |
| Crystal Archive 08F (Glossy) | Fujifilm | 불가 | — | — | 특성곡선 없음. **분광 곡선은 벡터**(p5) |

**⚠️ Fuji는 인화지 특성곡선을 발행하지 않는다.** 문서 2건(Deep Matte Velvet ·
Crystal Archive 08F)을 확인했고 둘 다 같다. Fuji의 Product Information Bulletin이
싣는 것은 **분광 감도 · 분광 염료 농도 · 미니랩 교정 절차**이고, D-logE 특성곡선은
어느 절에도 없다("CHARACTERISTIC"이라는 낱말은 `17. IMAGE STORAGE CHARACTERISTICS`
한 곳에만 나온다). Kodak은 싣는다 — 제조사의 문서 정책 차이다.

→ **인화지 톤은 Kodak으로 간다.** 종류를 늘리려면 Fuji를 더 찾을 게 아니라
Kodak의 다른 인화지(Supra / Ultra / Portra Endura)를 받는 쪽이 맞다. 현상소 차이
(Frontier ↔ Noritsu)는 원래대로 스캐너 스테이지에 남긴다.

- ⚠️ **인화지는 오렌지 마스크가 없어 층 순서 불변식(B>G>R)이 성립하지 않는다.**
  `extract_tds_curves.py`에 `paper` 인자를 넘겨야 한다. Endura는 오히려 R>G>B다(Dmax 기준)
- Fuji 08F p5의 분광 곡선은 벡터라 `extract_tds_spectral.py`로 뽑을 수 있다.
  **톤에는 못 쓰지만** 염료 비교(S2 계열)에는 쓸 수 있다 — 지금 필요해서 뽑지는 않았다

## 컬러 네거티브 (31건)

| 필름 | 제조사 | 상태 | 등급 | 곡선쪽 | Log H Ref | 출처 |
|---|---|---|---|---|---|---|
| Kodak Ektar 100 | Kodak | 생산 | A | p4 | -0.84 | [PDF](https://125px.com/docs/film/kodak/e4046_ektar_100-2016.pdf) |
| Kodak Gold 200 | Kodak | 생산 | A | p4 | -1.14 | [PDF](https://125px.com/docs/film/kodak/E7022_Gold_200-2016.pdf) |
| Kodak Portra 160 | Kodak | 생산 | A | p4 | -1.051 | [PDF](https://125px.com/docs/film/kodak/e4051_Portra_160-2016.pdf) |
| Kodak Portra 400 | Kodak | 생산 | A | p4 | -1.44 | [PDF](https://125px.com/docs/film/kodak/e4050_portra_400-2016.pdf) |
| Kodak Portra 800 | Kodak | 생산 | A | p4 | -1.74 | [PDF](https://125px.com/docs/film/kodak/e4040_portra_800-2016.pdf) |
| Kodak Portra NC/VC (chrysis) | Kodak | 단종 | A | p13 | -1.14 | [PDF](https://www.chrysis.net/wp-content/uploads/2020/09/KODAK-PROFESSIONAL-PORTRA160nc160vc400nv400vc800.pdf) |
| Kodak Portra NC/VC (filmcolors) | Kodak | 단종 | A | p10 | -1.74 | [PDF](https://filmcolors.org/wp-content/uploads/2025/12/KODAK-Professional-Portra-160NC-160VC-400NC-400VC-and-800-Films_E-190.pdf) |
| Kodak UltraMax 400 | Kodak | 생산 | A | p4 | -1.44 | [PDF](https://125px.com/docs/film/kodak/E7023_max_400-2016.pdf) |
| Agfa Professional (Tate) | Agfa | 단종 | B | p8 | — | [PDF](https://www.tate.org.uk/documents/598/page_6_7_agfa_stocks_0.pdf) |
| Agfa Professional Films | Agfa | 단종 | B | p8 | — | [PDF](https://cacreeks.com/photos/agfaPro.pdf) |
| Fuji Professional Data Guide | Fuji | 혼합 | B | p51 | — | [PDF](https://asset.fujifilm.com/www/ca/files/2020-03/d52487c5c6f84e7f935c299491c5c1ff/ProfessionalFilmDataGuide.pdf) |
| Fuji Superia 100 | Fuji | 단종 | B | p2 | — | [PDF](https://125px.com/docs/film/fuji/superia_100_datasheet.pdf) |
| Fuji Superia 1600 | Fuji | 단종 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/superia_1600_datasheet.pdf) |
| Fuji Superia 200 | Fuji | 생산 | B | p4 | — | [PDF](https://125px.com/docs/film/fuji/superia_200_datasheet.pdf) |
| Fuji Superia X-tra 400 | Fuji | 생산 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/superia_xtra400_datasheet.pdf) |
| Fuji Superia X-tra 800 | Fuji | 단종 | B | p4 | — | [PDF](https://125px.com/docs/film/fuji/superia_xtra800_datasheet.pdf) |
| Fuji True Definition 400 | Fuji | 단종 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/True_Definition_DataSheet.pdf) |
| Kodak Gold 100/200 (1998) | Kodak | 단종 | B | p3 | — | [PDF](https://125px.com/docs/film/kodak/e42-1998_02.pdf) |
| Kodak Portra NC/VC (E-190 alt) | Kodak | 단종 | B | p13 | -1.74 | [PDF](https://125px.com/docs/unsorted/kodak/e190-1.pdf) |
| Kodak Portra NC/VC/800 (E-190) | Kodak | 단종 | B | p10 | — | [PDF](https://125px.com/docs/unsorted/kodak/e190.pdf) |
| Kodak Royal Gold 200 | Kodak | 단종 | B | p4 | — | [PDF](https://125px.com/docs/film/kodak/e7006-2002_03.pdf) |
| Kodak UltraMax 800 | Kodak | 단종 | B | p3 | — | [PDF](https://125px.com/docs/film/kodak/E7024-Ultra_Max_800.pdf) |
| Kodak Vericolor III | Kodak | 단종 | B | p4 | — | [PDF](https://125px.com/docs/film/kodak/e26-Vericolor_III.pdf) |
| Kodak Vision3 500T (official) | Kodak | 생산 | B | p2 | — | [PDF](https://www.kodak.com/content/products-brochures/Film/VISION3_5219_7219_Technical-data.pdf) |
| Kodak Vision3 500T 5219 | Kodak | 생산 | B | p4 | — | [PDF](https://125px.com/docs/motionpicture/kodak/5219-Vision3-500T-tech.pdf) |
| Fuji Pro 160C | Fuji | 단종 | C | p8 | — | [PDF](https://125px.com/docs/film/fuji/pro_160c_datasheet.pdf) |
| Fuji Pro 160S | Fuji | 단종 | C | p8 | — | [PDF](https://125px.com/docs/film/fuji/pro_160s_datasheet.pdf) |
| Fuji Pro 400H | Fuji | 단종 | C | p8 | — | [PDF](https://125px.com/docs/film/fuji/pro_400h_datasheet.pdf) |
| Fuji Pro 800Z | Fuji | 단종 | C | p8 | — | [PDF](https://125px.com/docs/film/fuji/pro_800z_datasheet.pdf) |
| Fuji Superia Reala | Fuji | 단종 | C | p4 | — | [PDF](https://125px.com/docs/film/fuji/superia_reala_datasheet.pdf) |
| Fuji NPZ 800 | Fuji | 단종 | D | p1 | — | [PDF](https://125px.com/docs/film/fuji/NPZ.pdf) |

## 리버설(슬라이드) (25건)

| 필름 | 제조사 | 상태 | 등급 | 곡선쪽 | Log H Ref | 출처 |
|---|---|---|---|---|---|---|
| Fuji 64T Type II | Fuji | 단종 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/RTPIIAF3-024E_1.pdf) |
| Fuji Astia 100F | Fuji | 단종 | B | p8 | — | [PDF](https://125px.com/docs/film/fuji/astia_100f_datasheet.pdf) |
| Fuji Provia 100F | Fuji | 생산 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/provia_100f_datasheet.pdf) |
| Fuji Provia 400F | Fuji | 단종 | B | p6 | — | [PDF](https://125px.com/docs/film/fuji/PROVIA400FAF3-066E_1.pdf) |
| Fuji Provia 400X | Fuji | 단종 | B | p7 | — | [PDF](https://125px.com/docs/film/fuji/Provia_400X_PIB_1007.pdf) |
| Fuji T64 | Fuji | 단종 | B | p7 | — | [PDF](https://125px.com/docs/film/fuji/t64_datasheet.pdf) |
| Fuji Velvia 100 | Fuji | 단종 | B | p7 | — | [PDF](https://125px.com/docs/film/fuji/velvia_100_datasheet.pdf) |
| Fuji Velvia 100F | Fuji | 단종 | B | p8 | — | [PDF](https://125px.com/docs/film/fuji/velvia_100f_datasheet.pdf) |
| Kodak Ektachrome 100 Plus EPP | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e113-Ektachrome_100_plus_EPP.pdf) |
| Kodak Ektachrome 160T EPT | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e144-Ektachrome_160T_EPT.pdf) |
| Kodak Ektachrome 320T EPJ | Kodak | 단종 | B | p4 | — | [PDF](https://125px.com/docs/film/kodak/e145-Ektachrome_320T_EPJ.pdf) |
| Kodak Ektachrome 400X EPL | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e161-Ektachrome_400X_EPL.pdf) |
| Kodak Ektachrome 64 EPR | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e8-Ektachrome_64_EPR.pdf) |
| Kodak Ektachrome 64T EPY | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e130-Ektachrome_64T_EPY.pdf) |
| Kodak Ektachrome E100G | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e4024-2009.pdf) |
| Kodak Ektachrome E100VS | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e163-Ektachrome_E100VS.pdf) |
| Kodak Ektachrome E200 | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e28-Ektachrome_E200.pdf) |
| Kodak Ektachrome P1600 EPH | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e147-Ektachrome_P1600_EPH.pdf) |
| Kodak Kodachrome (E-88) | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e88-2009_06.pdf) |
| Kodak Kodachrome 25 (E-88 2002) | Kodak | 단종 | B | p7 | — | [PDF](https://125px.com/docs/film/kodak/e88-2002_03.pdf) |
| Kodak Kodachrome Pro (E-55) | Kodak | 단종 | B | p5 | — | [PDF](https://125px.com/docs/film/kodak/e55-2009_06.pdf) |
| Fuji Sensia 200 | Fuji | 단종 | C | p5 | — | [PDF](https://125px.com/docs/film/fuji/sensia_200_datasheet.pdf) |
| Fuji Sensia 400 | Fuji | 단종 | C | p5 | — | [PDF](https://125px.com/docs/film/fuji/sensia_400_datasheet.pdf) |
| Fuji Sensia 100 | Fuji | 단종 | D | p5 | — | [PDF](https://125px.com/docs/film/fuji/sensia_100_datasheet.pdf) |
| Fuji Velvia 50 | Fuji | 생산 | D | p8 | — | [PDF](https://125px.com/docs/film/fuji/velvia_50_datasheet.pdf) |

## 흑백 (8건)

| 필름 | 제조사 | 상태 | 등급 | 곡선쪽 | Log H Ref | 출처 |
|---|---|---|---|---|---|---|
| Kodak Portra 400BW | Kodak | 단종 | B | p6 | — | [PDF](https://125px.com/docs/film/kodak/f4012-Portra_400BW.pdf) |
| Kodak T-MAX 100 | Kodak | 생산 | B | p8 | — | [PDF](https://125px.com/docs/film/kodak/f4016_tmax_100-2018.pdf) |
| Kodak T-MAX 400 | Kodak | 생산 | B | p8 | — | [PDF](https://125px.com/docs/film/kodak/f4043_TMax_400-2016.pdf) |
| Kodak T-MAX P3200 | Kodak | 생산 | B | p7 | — | [PDF](https://125px.com/docs/film/kodak/f4001-P3200TMZ-2019.pdf) |
| Kodak Tri-X 320/400 | Kodak | 생산 | B | p8 | — | [PDF](https://125px.com/docs/film/kodak/f4017-2016.pdf) |
| Fuji Neopan 1600 | Fuji | 단종 | D | p1 | — | [PDF](https://125px.com/docs/film/fuji/Neopan1600.pdf) |
| Fuji Neopan 400 | Fuji | 단종 | D | p1 | — | [PDF](https://125px.com/docs/film/fuji/Neopan400.pdf) |
| Fuji Neopan Acros 100 | Fuji | 단종 | D | p1 | — | [PDF](https://125px.com/docs/film/fuji/NeopanAcros100.pdf) |
