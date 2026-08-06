"""
`tungstenCast`를 분광 감도에서 **유도**한다 (TODO S1).

films.js의 Vision3 500T `tungstenCast`는 지금 "실기 눈으로 맞춘 값"이다. TDS의
D-logE 곡선만으로는 광원을 바꿀 수 없기 때문이다 — 그 곡선은 "필름 + 3200K 노광 +
Status M 농도"라는 **한 세트의 측정**이고, 파장 정보가 이미 적분돼 사라진 뒤다.

같은 TDS 4쪽의 **분광 감도 곡선**에는 그 파장 정보가 남아 있다. 층별 감도
S_c(λ)를 알면 광원 I(λ)를 바꿨을 때 층이 받는 노광이 얼마나 달라지는지 적분으로
나온다.

    E_c(I) = ∫ I(λ) · 10^{logS_c(λ)} dλ
    cast_c = log10( E_c(주광) / E_c(3200K) )

Kodak의 정의는 "sensitivity = 특정 농도를 내는 데 필요한 노광(erg/cm²)의 역수"다.
erg/cm²는 **에너지**이므로 S_c는 단위 에너지당 감도이고, 분광 **복사**분포와 그대로
곱하면 된다(측광량으로 환산하면 안 된다).

── 정규화 규약 ─────────────────────────────────────────────────────────

세 채널에 같은 상수를 더하는 것은 전체 노광을 옮기는 것과 같다. 무엇을 기준으로
둘지가 규약이고, 물리가 정해 주지 않는다. 그래서 세 가지를 모두 계산해 보고한다.

  meter   두 광원의 **측광 휘도**를 맞춘 뒤의 값. 노출계를 믿고 무보정으로
          찍는 상황에 해당한다. 남는 공통 성분은 "그 필름이 주광에서 실효적으로
          빠르거나 느리다"는 실제 현상이다.
  green   녹감층을 0으로 고정. 코드가 cast를 H에만 더하고 d0에는 안 더하므로
          공통 성분이 전체 밝기를 움직인다 — 스캐너가 그것을 되돌린다고 보면
          녹감(휘도 대용) 고정이 자연스럽다.
  mean    평균 0.

채널 **차이**(b−r 등)는 규약과 무관하다. 판단은 그 값으로 하는 것이 안전하다.
"""
import sys, json, math

# --- CIE 주광 기저 함수 S0/S1/S2 (10nm) --------------------------------------
# 출처: CIE 15:2004 표 T.2 / ISO 11664-2. colour-science 0.4의 데이터셋과 대조해
# 일치를 확인했다(아래 `--selftest`). 표준의 사실 데이터이므로 그대로 싣는다.
CIE_D_S = {
    300: (0.04, 0.02, 0), 310: (6, 4.5, 2), 320: (29.6, 22.4, 4),
    330: (55.3, 42, 8.5), 340: (57.3, 40.6, 7.8), 350: (61.8, 41.6, 6.7),
    360: (61.5, 38, 5.3), 370: (68.8, 42.4, 6.1), 380: (63.4, 38.5, 3),
    390: (65.8, 35, 1.2), 400: (94.8, 43.4, -1.1), 410: (104.8, 46.3, -0.5),
    420: (105.9, 43.9, -0.7), 430: (96.8, 37.1, -1.2), 440: (113.9, 36.7, -2.6),
    450: (125.6, 35.9, -2.9), 460: (125.5, 32.6, -2.8), 470: (121.3, 27.9, -2.6),
    480: (121.3, 24.3, -2.6), 490: (113.5, 20.1, -1.8), 500: (113.1, 16.2, -1.5),
    510: (110.8, 13.2, -1.3), 520: (106.5, 8.6, -1.2), 530: (108.8, 6.1, -1),
    540: (105.3, 4.2, -0.5), 550: (104.4, 1.9, -0.3), 560: (100, 0, 0),
    570: (96, -1.6, 0.2), 580: (95.1, -3.5, 0.5), 590: (89.1, -3.5, 2.1),
    600: (90.5, -5.8, 3.2), 610: (90.3, -7.2, 4.1), 620: (88.4, -8.6, 4.7),
    630: (84, -9.5, 5.1), 640: (85.1, -10.9, 6.7), 650: (81.9, -10.7, 7.3),
    660: (82.6, -12, 8.6), 670: (84.9, -14, 9.8), 680: (81.3, -13.6, 10.2),
    690: (71.9, -12, 8.3), 700: (74.3, -13.3, 9.6), 710: (76.4, -12.9, 8.5),
    720: (63.3, -10.6, 7), 730: (71.7, -11.6, 7.6), 740: (77, -12.2, 8),
    750: (65.2, -10.2, 6.7), 760: (47.7, -7.8, 5.2), 770: (68.6, -11.2, 7.4),
    780: (65, -10.4, 6.8), 790: (66, -10.6, 7),
}

# CIE 1924 측광 시감효율 V(λ) (10nm). 노출계 대용으로만 쓴다.
V_LAMBDA = {
    380: 3.9e-05, 390: 0.00012, 400: 0.000396, 410: 0.00121, 420: 0.004,
    430: 0.0116, 440: 0.023, 450: 0.038, 460: 0.06, 470: 0.09098,
    480: 0.13902, 490: 0.20802, 500: 0.323, 510: 0.503, 520: 0.71,
    530: 0.862, 540: 0.954, 550: 0.99495, 560: 0.995, 570: 0.952,
    580: 0.87, 590: 0.757, 600: 0.631, 610: 0.503, 620: 0.381,
    630: 0.265, 640: 0.175, 650: 0.107, 660: 0.061, 670: 0.032,
    680: 0.017, 690: 0.00821, 700: 0.004102, 710: 0.002091, 720: 0.001047,
    730: 0.00052, 740: 0.0002492, 750: 0.00012, 760: 6e-05, 770: 3e-05,
    780: 1.499e-05,
}

C2 = 1.4388e7  # 제2 복사상수 [nm·K] — CIE/ITS-90 관례값(1.4388e-2 m·K)


def lerp_table(table, wl):
    """10nm 표를 선형 보간. 표 밖은 0."""
    ks = sorted(table)
    if wl < ks[0] or wl > ks[-1]:
        return 0.0
    lo = int(math.floor(wl / 10.0) * 10)
    hi = lo + 10
    if lo not in table:
        return 0.0
    if hi not in table:
        return table[lo] if not isinstance(table[lo], tuple) else table[lo]
    t = (wl - lo) / 10.0
    a, b = table[lo], table[hi]
    if isinstance(a, tuple):
        return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
    return a + (b - a) * t


def planck(wl, T):
    """흑체 분광 복사발산도(상대). λ [nm]."""
    return (wl ** -5) / (math.exp(C2 / (wl * T)) - 1.0)


def daylight(wl, T):
    """
    CIE 주광 분광분포. T는 상관색온도.

    ⚠️ 주광은 흑체가 아니다. 5500K 흑체로 대신하면 청색부가 다르게 나온다 —
    이 스크립트가 두 가지를 모두 보고하는 이유다.
    """
    if T <= 7000:
        xd = (-4.6070e9 / T ** 3 + 2.9678e6 / T ** 2 + 0.09911e3 / T + 0.244063)
    else:
        xd = (-2.0064e9 / T ** 3 + 1.9018e6 / T ** 2 + 0.24748e3 / T + 0.237040)
    yd = -3.000 * xd * xd + 2.870 * xd - 0.275
    m = 0.0241 + 0.2562 * xd - 0.7341 * yd
    m1 = (-1.3515 - 1.7703 * xd + 5.9114 * yd) / m
    m2 = (0.0300 - 31.4424 * xd + 30.0717 * yd) / m
    s = lerp_table(CIE_D_S, wl)
    if s == 0.0:
        return 0.0
    return s[0] + m1 * s[1] + m2 * s[2]


def sensitivity_fn(points, extrapolate=False, span=15.0):
    """
    분광 감도 곡선(파장, 로그감도)을 선형 보간 함수로.

    ⚠️ TDS는 곡선을 끝까지 그리지 않는다. Vision3 500T는 시안층을 678nm에서
    끊는데 그 지점 감도가 아직 **피크의 17%**다 — 무시할 꼬리가 아니다. 게다가
    텅스텐광은 장파장이 강해서 잘린 쪽에 힘이 실린다.

    그래서 두 가지로 계산해 둘의 차이를 불확실성으로 보고한다.
      기본        그린 범위 밖 = 0 (꼬리 기여를 **0으로 과소평가**)
      extrapolate 양끝 span[nm]의 기울기로 로그선형 연장 (꼬리를 **과대평가**)
    참값은 둘 사이에 있다.
    """
    pts = sorted(points)

    def edge_slope(a, b):
        return (b[1] - a[1]) / (b[0] - a[0]) if b[0] != a[0] else 0.0

    lo_i = next((i for i in range(len(pts)) if pts[i][0] - pts[0][0] >= span), 1)
    hi_i = next((i for i in range(len(pts) - 1, -1, -1) if pts[-1][0] - pts[i][0] >= span), len(pts) - 2)
    slope_lo = edge_slope(pts[lo_i], pts[0])   # 왼쪽 밖으로 나갈 때의 기울기
    slope_hi = edge_slope(pts[hi_i], pts[-1])  # 오른쪽 밖으로 나갈 때의 기울기

    def f(wl):
        if wl < pts[0][0]:
            if not extrapolate:
                return 0.0
            return 10.0 ** (pts[0][1] + slope_lo * (wl - pts[0][0]))
        if wl > pts[-1][0]:
            if not extrapolate:
                return 0.0
            return 10.0 ** (pts[-1][1] + slope_hi * (wl - pts[-1][0]))
        lo, hi = 0, len(pts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if pts[mid][0] <= wl:
                lo = mid
            else:
                hi = mid
        x0, y0 = pts[lo]
        x1, y1 = pts[hi]
        t = 0.0 if x1 == x0 else (wl - x0) / (x1 - x0)
        return 10.0 ** (y0 + (y1 - y0) * t)

    return f


GRID = [360 + i for i in range(0, 421)]  # 360~780nm, 1nm


def integrate(illum, sens):
    return sum(illum(wl) * sens(wl) for wl in GRID)


def luminance(illum):
    return sum(illum(wl) * lerp_table(V_LAMBDA, wl) for wl in GRID)


def selftest():
    """CIE 주광 구현을 colour-science와 대조한다(있을 때만)."""
    try:
        import colour
    except ImportError:
        print("colour-science가 없어 자체검증을 건너뜁니다")
        return
    ref = colour.colorimetry.SDS_ILLUMINANTS["D55"]
    mine = [daylight(wl, 5503) for wl in range(360, 781, 10)]
    theirs = [float(ref[wl]) for wl in range(360, 781, 10)]
    k = sum(m * t for m, t in zip(mine, theirs)) / sum(m * m for m in mine)
    worst = max(abs(k * m - t) / max(theirs) for m, t in zip(mine, theirs))
    print(f"D55 자체검증: 최대 상대편차 {worst * 100:.3f}%  ({'OK' if worst < 0.005 else '불일치'})")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if len(sys.argv) < 2:
        raise SystemExit("사용법: derive-tungsten-cast.py <extract_tds_spectral.py 출력 json> [--json]")

    data = json.load(open(sys.argv[1]))
    if data.get("kind") != "sensitivity":
        raise SystemExit("분광 **감도** 추출 결과가 필요합니다")
    tungK = data.get("exposureK") or 3200

    # 발색층 이름 → 코드의 채널. 옐로 발색층이 청감층이다(보색 관계).
    LAYER_TO_CH = {"yellow": "b", "magenta": "g", "cyan": "r"}
    ext = "--extrapolate" in sys.argv
    sens, tails = {}, {}
    for layer, ch in LAYER_TO_CH.items():
        c = data["curves"][layer]
        sens[ch] = sensitivity_fn(c["points"], ext)
        pk = c["peak"][1]
        ends = [c["points"][0][1], c["points"][-1][1]]
        tails[ch] = round(10 ** (max(ends) - pk), 5)

    illums = {
        f"planck{tungK}": lambda wl: planck(wl, tungK),
        "D55": lambda wl: daylight(wl, 5503),
        "D65": lambda wl: daylight(wl, 6504),
        "planck5500": lambda wl: planck(wl, 5500),
    }
    lum = {k: luminance(v) for k, v in illums.items()}
    E = {k: {ch: integrate(v, sens[ch]) for ch in "rgb"} for k, v in illums.items()}

    base = f"planck{tungK}"
    report = {
        "source": data["pdf"],
        "tungstenK": tungK,
        "peaksNm": data["peaks"],
        "tailBound": tails,
        "casts": {},
    }
    lines = []
    for name in illums:
        if name == base:
            continue
        # 측광 휘도를 맞춘다 = 노출계를 믿고 무보정으로 찍는 상황
        k = lum[base] / lum[name]
        raw = {ch: math.log10(E[name][ch] * k / E[base][ch]) for ch in "rgb"}
        mean = sum(raw.values()) / 3
        report["casts"][name] = {
            "meter": {ch: round(raw[ch], 4) for ch in "rgb"},
            "green": {ch: round(raw[ch] - raw["g"], 4) for ch in "rgb"},
            "mean": {ch: round(raw[ch] - mean, 4) for ch in "rgb"},
            "bMinusR": round(raw["b"] - raw["r"], 4),
            "gMinusR": round(raw["g"] - raw["r"], 4),
        }
        lines.append(
            f"  {name:12s} meter r{raw['r']:+.3f} g{raw['g']:+.3f} b{raw['b']:+.3f}"
            f"   b−r {raw['b'] - raw['r']:+.3f}  g−r {raw['g'] - raw['r']:+.3f}"
        )

    if "--json" in sys.argv:
        print(json.dumps(report, indent=1))
        return

    print(f"{data['pdf']}  텅스텐 기준 {tungK}K")
    print(f"  피크 파장(nm)  R(시안층) {data['peaks']['cyan']:.0f}  "
          f"G(마젠타층) {data['peaks']['magenta']:.0f}  B(옐로층) {data['peaks']['yellow']:.0f}")
    print(f"  꼬리 절단 상한(피크 대비)  r {tails['r']:.4f}  g {tails['g']:.4f}  b {tails['b']:.4f}")
    print("주광 대 텅스텐 로그노광 차:")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
