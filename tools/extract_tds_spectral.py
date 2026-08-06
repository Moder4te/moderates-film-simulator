"""
Kodak TDS **분광** 곡선 추출기 — 분광 감도(Spectral Sensitivity)와
분광 염료 농도(Spectral Dye Density).

`extract_tds_curves.py`가 D-logE(특성곡선)를 뽑는다면, 이쪽은 같은 TDS의
분광 도면을 뽑는다. 둘을 하나로 합치지 않은 이유는 **좌표계도 곡선 식별
방법도 다르기 때문**이다.

  특성곡선   x=로그노광, y=농도, 층 이름이 'R'/'G'/'B' 한 글자,
             컬러 네거티브는 B>G>R 농도 순서라는 물리 불변식이 있다.
  분광곡선   x=파장(nm), y=로그감도 또는 분광농도, 층 이름이
             'Yellow-Forming Layer' 같은 여러 단어, 불변식은 **피크 파장 순서**다.

── 왜 x-backtrack으로 자르는가 ─────────────────────────────────────────

Vision3 500T(H-1-5219t) 4쪽은 곡선 세 개가 벡터 경로 네 개에 걸쳐 있고,
경로 경계가 곡선 경계와 **일치하지 않는다**. 예를 들어 경로 60은 옐로층
곡선을 끝까지 그린 뒤 펜을 되돌려 마젠타층 곡선의 앞부분을 조금 그리고
끝난다. 그 이어지는 부분이 경로 61의 첫 점이다.

`extract_tds_curves.py`의 `split_subpaths`(간격 중앙값 배수)로는 이걸 못 가른다.
되돌아가는 점프(24pt)는 잡아도, 같은 경로 안에서 곡선이 가파른 구간의 정상
간격(5.8pt)까지 단절로 오인해 멀쩡한 곡선을 두 동강 낸다(실측).

분광 곡선은 **파장의 단일값 함수**다 — x가 뒤로 가는 일이 없다. 그래서
"x가 뒤로 간 지점"만 자르면 오검출이 원리적으로 없다. 자른 조각들은 끝점이
정확히 일치하는 것끼리 다시 잇는다.
"""
import sys, json, re, fitz

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from extract_tds_curves import flatten, norm_number  # noqa: E402

CURVE_WIDTH_MIN = 0.7  # 곡선 획 굵기(0.96). 축·눈금(0.5)과 가른다.


def stroke_pieces(draws, region, back_tol=0.5):
    """
    영역 안의 곡선 획을 모아 **x 단조 조각**으로 자른다.

    back_tol은 "x가 이만큼 뒤로 가면 새 곡선의 시작"이라는 문턱이다. 곡선을 이루는
    이웃 점은 x가 늘거나 제자리(수직 구간)라 0.5pt면 충분하고, 실제 되돌아감은
    수십 pt다(Vision3 4쪽 실측 24~30pt).
    """
    out = []
    for i, d in enumerate(draws):
        w = d.get("width")
        if not w or w < CURVE_WIDTH_MIN:
            continue
        if not region.intersects(d["rect"]):
            continue
        pts, _ = flatten(d["items"])
        if len(pts) < 4:
            continue
        cur = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            if b[0] < a[0] - back_tol:
                out.append((i, cur))
                cur = [b]
            else:
                cur.append(b)
        out.append((i, cur))
    return [(i, p) for i, p in out if len(p) >= 3]


def chain(pieces, tol=0.15):
    """
    끝점이 맞물리는 조각을 잇는다. 한 곡선이 여러 경로에 나뉘어 있어도 복원된다.

    ⚠️ 자기 자신과 잇지 않도록 조각마다 한 번씩만 소비한다. 그리고 **끝점이
    정확히 일치할 때만** 잇는다(0.15pt) — 느슨하게 잡으면 서로 교차하는 두 곡선이
    교차점에서 붙어 버린다.
    """
    segs = [list(p) for _, p in pieces]
    used = [False] * len(segs)
    result = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        cur = segs[i]
        moved = True
        while moved:
            moved = False
            for j in range(len(segs)):
                if used[j]:
                    continue
                s = segs[j]
                if abs(s[0][0] - cur[-1][0]) < tol and abs(s[0][1] - cur[-1][1]) < tol:
                    cur = cur + s[1:]
                elif abs(cur[0][0] - s[-1][0]) < tol and abs(cur[0][1] - s[-1][1]) < tol:
                    cur = s + cur[1:]
                else:
                    continue
                used[j] = True
                moved = True
        result.append(cur)
    return result


def fit_axis(labels):
    """
    (위치, 값) 목록에 최소제곱 직선을 맞춰 (기울기, 절편, 최대잔차[값 단위])를 낸다.

    **프레임 모서리에 값을 못박지 않는다.** Vision3 4쪽 분광감도 도면에서 프레임
    사각형은 라벨 눈금보다 0.65pt(=1.6nm) 밖에 있다 — 획 굵기 때문이다. 못박으면
    파장 전체가 1.6nm 밀리고, 그 오차가 유도값에 그대로 남는다. 라벨은 11개나
    있으므로 회귀가 더 정확하고, 잔차가 곧 신뢰도 보고서가 된다.
    """
    n = len(labels)
    sx = sum(p for p, _ in labels)
    sy = sum(v for _, v in labels)
    sxx = sum(p * p for p, _ in labels)
    sxy = sum(p * v for p, v in labels)
    den = n * sxx - sx * sx
    if abs(den) < 1e-9:
        raise SystemExit("축 라벨 위치가 모두 같습니다")
    a = (n * sxy - sx * sy) / den
    b = (sy - a * sx) / n
    worst = max(abs(a * p + b - v) for p, v in labels)
    return a, b, worst


def axis_labels(words, frame, axis, region):
    """축 라벨(숫자)을 위치·값 쌍으로 모은다. x는 프레임 아래, y는 프레임 왼쪽."""
    left, top, right, bottom = frame
    out = []
    for w in words:
        s = norm_number(w[4])
        if s is None:
            continue
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        if not (region.x0 - 5 < cx < region.x1 + 5 and region.y0 - 5 < cy < region.y1 + 5):
            continue
        if axis == "x":
            if bottom - 2 < w[1] < bottom + 25 and left - 25 < cx < right + 25:
                out.append((cx, float(s)))
        else:
            if w[2] < left + 2 and top - 15 < cy < bottom + 15:
                out.append((cy, float(s)))
    if len(out) < 3:
        raise SystemExit(f"{axis}축 라벨이 {len(out)}개뿐입니다(3개 이상 필요)")
    out.sort()
    return out


def find_frame(draws, region):
    """플롯 프레임 = 영역 안에서 가장 큰 사각형 경로(획 있는 것)."""
    best = None
    for d in draws:
        if not d.get("width"):
            continue
        for it in d["items"]:
            if it[0] != "re":
                continue
            r = it[1]
            if not region.intersects(r) or r.width < 50 or r.height < 50:
                continue
            if best is None or r.width * r.height > best.width * best.height:
                best = r
    if best is None:
        raise SystemExit("프레임 사각형을 찾지 못했습니다")
    return best.x0, best.y0, best.x1, best.y1


# 층 이름 표기. 분광감도 도면은 발색층 이름, 염료농도 도면은 염료 이름을 쓴다.
SENS_LAYERS = [("Yellow-", "yellow"), ("Magenta-", "magenta"), ("Cyan-", "cyan")]
DYE_LAYERS = [("Yellow", "yellow"), ("Magenta", "magenta"), ("Cyan", "cyan")]


def find_layer_labels(words, frame, table):
    """프레임 안(또는 바로 곁)의 층 이름 위치를 찾는다. 값은 라벨 상자 중심."""
    left, top, right, bottom = frame
    found = {}
    for w in words:
        for token, name in table:
            if w[4] != token.rstrip("-") and w[4] != token:
                continue
            cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
            if left - 5 < cx < right + 5 and top - 5 < cy < bottom + 5:
                found[name] = (cx, cy)
    return found


def assign(chains, labels):
    """라벨-곡선 최근접 배정(가까운 쌍부터 확정). 배정 여유도 함께 낸다."""
    pairs = []
    for name, (lx, ly) in labels.items():
        for k, c in enumerate(chains):
            d2 = min((px - lx) ** 2 + (py - ly) ** 2 for px, py in c)
            pairs.append((d2 ** 0.5, name, k))
    pairs.sort()
    got, usedN, usedC = {}, set(), set()
    for dist, name, k in pairs:
        if name in usedN or k in usedC:
            continue
        got[name] = (k, dist)
        usedN.add(name)
        usedC.add(k)
    margins = {}
    for name, (k, dist) in got.items():
        others = [p[0] for p in pairs if p[1] == name and p[2] != k]
        margins[name] = round(min(others) - dist, 2) if others else None
    return got, margins


def main():
    """
    사용법:
      extract_tds_spectral.py <pdf> <페이지> <x0> <y0> <x1> <y1> <sensitivity|dye>
    """
    if len(sys.argv) < 8:
        raise SystemExit(main.__doc__)
    pdf, pageno = sys.argv[1], int(sys.argv[2])
    region = fitz.Rect(*map(float, sys.argv[3:7]))
    kind = sys.argv[7]
    if kind not in ("sensitivity", "dye"):
        raise SystemExit("종류는 sensitivity 또는 dye 입니다")

    doc = fitz.open(pdf)
    page = doc[pageno - 1]
    draws = page.get_drawings()
    words = page.get_text("words")

    frame = find_frame(draws, region)
    left, top, right, bottom = frame

    xa, xb, xres = fit_axis(axis_labels(words, frame, "x", region))
    ya, yb, yres = fit_axis(axis_labels(words, frame, "y", region))

    pieces = stroke_pieces(draws, region)
    chains = [c for c in chain(pieces) if len(c) >= 20]
    if not chains:
        raise SystemExit("곡선 후보가 없습니다")

    table = SENS_LAYERS if kind == "sensitivity" else DYE_LAYERS
    labels = find_layer_labels(words, frame, table)
    if len(labels) != 3:
        raise SystemExit(f"층 라벨 3개를 못 찾았습니다: {sorted(labels)}")
    got, margins = assign(chains, labels)

    # `--assign-by-peak` — 라벨 **위치**로 "어느 곡선 셋인가"만 정하고, **이름**은
    # 피크 파장 순서로 다시 붙인다. 아래 불변식 절 참조: 이 TDS(H-1-5219t)는 염료
    # 농도 도면의 Cyan/Yellow 이름이 서로 뒤바뀌어 있다.
    disagree = None
    if "--assign-by-peak" in sys.argv:
        def peak_wl(k):
            return max(chains[k], key=lambda q: ya * q[1] + yb)[0]

        ordered = sorted(got.items(), key=lambda kv: peak_wl(kv[1][0]))
        renamed, disagree = {}, {}
        for correct, (printed, slot) in zip(("yellow", "magenta", "cyan"), ordered):
            renamed[correct] = slot
            if printed != correct:
                disagree[correct] = printed
        got = renamed

    def to_data(px, py):
        return xa * px + xb, ya * py + yb

    out = {
        "pdf": pdf.rsplit("/", 1)[-1],
        "page": pageno,
        "kind": kind,
        "frame": {"left": left, "top": top, "right": right, "bottom": bottom},
        "axisFit": {
            "x": {"nmPerPt": round(xa, 5), "maxResidual": round(xres, 3)},
            "y": {"unitPerPt": round(ya, 6), "maxResidual": round(yres, 4)},
        },
        "labels": {k: [round(v[0], 1), round(v[1], 1)] for k, v in labels.items()},
        "labelMatchMargin": margins,
        "assignedBy": "peak" if disagree is not None else "label",
        "labelDisagreement": disagree or None,
        "nChains": len(chains),
        "curves": {},
    }

    peaks = {}
    for name in ("yellow", "magenta", "cyan"):
        k, dist = got[name]
        data = [to_data(x, y) for x, y in chains[k]]
        clean = []
        for wl, v in data:
            if not clean or wl > clean[-1][0] + 1e-6:
                clean.append((wl, v))
            elif v > clean[-1][1]:  # 수직 구간은 위쪽(값이 큰 쪽)을 남긴다
                clean[-1] = (wl, v)
        pk = max(clean, key=lambda p: p[1])
        peaks[name] = pk[0]
        out["curves"][name] = {
            "labelDistance": round(dist, 2),
            "nPoints": len(clean),
            "wavelengthRange": [round(clean[0][0], 1), round(clean[-1][0], 1)],
            "valueRange": [round(min(v for _, v in clean), 4), round(max(v for _, v in clean), 4)],
            "peak": [round(pk[0], 1), round(pk[1], 4)],
            "points": [[round(wl, 2), round(v, 5)] for wl, v in clean],
        }

    # --- 물리 불변식 -------------------------------------------------------
    #
    # 옐로 발색층은 청감(단파), 마젠타는 녹감, 시안은 적감이다. 염료 흡수도 같은
    # 순서다 — 정의상 그렇다. **적색을 흡수하는 염료를 시안이라 부르는 것**이고,
    # 청색(445nm)을 흡수하는 염료는 노랗게 보인다. 그래서 어느 도면이든 피크
    # 파장은 옐로 < 마젠타 < 시안이어야 한다.
    #
    # ⚠️ H-1-5219t(Vision3 500T) 4쪽 **Spectral Dye Density 도면은 Cyan과 Yellow
    # 이름이 서로 뒤바뀌어 인쇄돼 있다.** 445nm 피크에 'Cyan', 685nm 피크에
    # 'Yellow'가 붙어 있다. 같은 쪽 Spectral Sensitivity 도면은 옳다(Yellow-Forming
    # Layer가 400nm 청감, Cyan-Forming Layer가 650nm 적감) — 적감층이 만드는 염료가
    # 적색을 흡수해야 네거티브가 성립하므로, 틀린 쪽은 염료 도면이다.
    #
    # 이 검사가 없었으면 크로스토크 행렬이 통째로 뒤집혀 나왔을 것이다. 조용히
    # 고치지 않고 멈춘 뒤, 호출자가 `--assign-by-peak`으로 명시하게 한다.
    if not (peaks["yellow"] < peaks["magenta"] < peaks["cyan"]):
        raise SystemExit(
            "층 배정이 물리 불변식을 어깁니다 — 피크 파장은 옐로<마젠타<시안이어야 "
            f"하는데 옐로={peaks['yellow']:.0f} 마젠타={peaks['magenta']:.0f} "
            f"시안={peaks['cyan']:.0f} nm 입니다. 도면의 이름 자체가 뒤바뀐 것이라면 "
            "`--assign-by-peak`으로 피크 순서 배정을 명시하십시오."
        )
    out["peaks"] = {k: round(v, 1) for k, v in peaks.items()}

    m = re.search(r"Exposure:\s*(\d{3,4})\s*K", page.get_text())
    out["exposureK"] = int(m.group(1)) if m else None

    print(json.dumps(out, indent=1))
    doc.close()


if __name__ == "__main__":
    main()
