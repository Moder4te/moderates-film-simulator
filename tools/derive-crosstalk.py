"""
분광 염료 농도 곡선에서 **원치 않는 흡수 행렬**을 유도한다 (TODO S2).

films.js의 `crosstalk`는 지금 전 필름 항등이다. "TDS에 층간 크로스토크 데이터가
없다"고 적어 뒀는데, 정확히는 **특성곡선 쪽에 없다**. 같은 TDS의 Spectral Dye
Density 도면에는 있다 — 시안·마젠타·옐로 염료가 각자 어느 파장을 얼마나
흡수하는지가 그 그림이다.

── 무엇을 구하는가 ─────────────────────────────────────────────────────

밴드 i의 적분 농도는 염료 j의 양 a_j의 합이다.

    D_i = Σ_j  M_ij · a_j          M_ij = 염료 j가 밴드 i에 내는 농도(단위량당)

M의 대각은 "제 몫", 비대각은 **원치 않는 흡수**다. 시안 염료가 녹색을 조금
먹고, 옐로 염료도 녹색을 조금 먹는다. 이것이 컬러 네거티브가 채도를 잃는
주된 물리 원인이다.

⚠️ **열 스케일은 게이지다.** M → M·P (P는 대각)이면 a → P⁻¹a 라서 D가 그대로다.
즉 염료의 "양" 단위를 어떻게 잡든 결과가 같고, **각 열의 비율만** 있으면 된다.
TDS의 염료 곡선이 피크 정규화(peak-normalized)라는 사실이 문제가 되지 않는
이유가 이것이다 — 정규화가 곧 열 스케일이다.

⚠️ **협대역 근사.** Status M 분광 응답도(ISO 7589)를 갖고 있지 않아, 각 밴드를
대표 파장 한 점으로 근사한다. 대신 부작용이 하나 사라진다: 농도는 파장 한 점에서
**정확히 가산**이지만(Beer-Lambert), 넓은 밴드에서는 −log∫10^{−D}가 되어
가산이 깨진다. 협대역 근사는 그 비선형을 아예 없앤다. 파장 선택 민감도는
`--bands`로 직접 흔들어 확인할 것.

⚠️ **이 행렬은 films.js의 `crosstalk` 자리에 그대로 못 넣는다.** 그 자리는
선형 포지티브 RGB에 곱하는 3×3인데, 여기서 나온 것은 **농도(로그) 공간**의
선형 사상이다. 자세한 판정은 docs/RESOLVED.md 참조.
"""
import sys, json

# ISO 7589 Status M의 대표 파장 근사. 수은선(435.8 / 546.1)과 적색 밴드 중심에서
# 왔다. 정확한 응답도 곡선이 아니므로 **근사**임을 잊지 말 것 — `--bands`로
# 흔들어 보면 비대각이 얼마나 움직이는지 바로 보인다.
DEFAULT_BANDS = (643.8, 546.1, 435.8)  # R, G, B


def interp(points):
    pts = sorted(points)

    def f(wl):
        if wl < pts[0][0] or wl > pts[-1][0]:
            raise SystemExit(f"{wl}nm는 곡선 범위 {pts[0][0]}~{pts[-1][0]} 밖입니다")
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
        return y0 + (y1 - y0) * t

    return f


def inv3(m):
    a, b, c = m[0]
    d, e, g = m[1]
    h, i, j = m[2]
    det = a * (e * j - g * i) - b * (d * j - g * h) + c * (d * i - e * h)
    if abs(det) < 1e-9:
        raise SystemExit("행렬이 특이합니다 — 밴드 파장을 확인하십시오")
    return [
        [(e * j - g * i) / det, (c * i - b * j) / det, (b * g - c * e) / det],
        [(g * h - d * j) / det, (a * j - c * h) / det, (c * d - a * g) / det],
        [(d * i - e * h) / det, (b * h - a * i) / det, (a * e - b * d) / det],
    ]


def main():
    if len(sys.argv) < 2:
        raise SystemExit("사용법: derive-crosstalk.py <dye json> [--bands R,G,B] [--json]")
    data = json.load(open(sys.argv[1]))
    if data.get("kind") != "dye":
        raise SystemExit("분광 **염료 농도** 추출 결과가 필요합니다")
    if data.get("assignedBy") != "peak" and data.get("labelDisagreement"):
        raise SystemExit("층 배정이 라벨 기준입니다 — 도면 이름이 뒤바뀐 TDS인지 확인하십시오")

    bands = DEFAULT_BANDS
    if "--bands" in sys.argv:
        bands = tuple(float(x) for x in sys.argv[sys.argv.index("--bands") + 1].split(","))

    dye = {k: interp(data["curves"][k]["points"]) for k in ("cyan", "magenta", "yellow")}
    # 행 = 밴드 R/G/B, 열 = 염료 시안/마젠타/옐로 (각각 적감/녹감/청감층 산물)
    M = [[dye["cyan"](b), dye["magenta"](b), dye["yellow"](b)] for b in bands]

    # 대각으로 나눠 열 게이지를 고정한다(각 염료가 제 밴드에 1을 낸다).
    norm = [[M[i][j] / M[j][j] for j in range(3)] for i in range(3)]

    out = {
        "source": data["pdf"],
        "bandsNm": list(bands),
        "matrix": [[round(v, 5) for v in row] for row in M],
        "normalized": [[round(v, 5) for v in row] for row in norm],
        "inverse": [[round(v, 5) for v in row] for row in inv3(norm)],
        "maxOffDiagonal": round(max(abs(norm[i][j]) for i in range(3) for j in range(3) if i != j), 4),
    }
    if "--json" in sys.argv:
        print(json.dumps(out, indent=1))
        return

    print(f"{data['pdf']}  밴드 {bands[0]:.1f}/{bands[1]:.1f}/{bands[2]:.1f} nm")
    print("원치 않는 흡수 행렬 (행=밴드 RGB, 열=염료 C/M/Y, 대각 1로 정규화)")
    for lab, row in zip("RGB", norm):
        print(f"  {lab}  " + "  ".join(f"{v:+.4f}" for v in row))
    print(f"비대각 최대 {out['maxOffDiagonal']:.4f}")


if __name__ == "__main__":
    main()
