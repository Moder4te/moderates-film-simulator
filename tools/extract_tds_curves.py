"""
Kodak TDS 특성곡선 추출기.

곡선이 벡터로 그려져 있으므로 좌표를 그대로 읽는다. 그래프를 눈으로 디지타이징하는
것보다 정확하고 재현 가능하다.

절차:
  1. 플롯 프레임을 찾는다 (가장 긴 수평/수직 선분 4개)
  2. 눈금 선분과 축 라벨 텍스트로 프레임 끝값을 확정한다
  3. 곡선 경로(점이 많은 경로)를 찾고 B/G/R 라벨로 층을 식별한다
  4. 베지어를 평탄화해 폴리라인으로 만들고 데이터 좌표로 변환한다
  5. 요청한 로그노광 위치에서 재샘플한다

출력은 JSON. 상대 로그노광(H=0이 Log H Ref)과 절대 로그노광을 모두 담는다.
"""
import sys, json, re, fitz


def flatten(items, steps=16, strict=True):
    """
    경로 아이템을 폴리라인 점 목록으로 편다. 베지어는 등간격 샘플.

    처리 아이템: 'l'(직선), 'c'(3차 베지어), 'qu'(2차 베지어).
    2차를 빼면 그 구간이 통째로 사라지고, 이후 x 정렬이 빈 곳을 직선으로 메워
    **왜곡이 눈에 띄지 않게 된다.** 그래서 처리하고, 모르는 아이템이 나오면
    strict 모드에서 소리 내어 실패한다 — 조용히 넘어가는 쪽이 더 위험하다.

    서브패스 단절(이전 세그먼트 끝 ≠ 다음 시작)도 세어 돌려준다. 끊긴 경로를
    한 곡선으로 이으면 없는 직선 현이 생긴다.
    """
    pts = []
    breaks = 0
    unknown = set()
    last_end = None

    def add(p):
        if not pts or abs(p[0] - pts[-1][0]) > 1e-9 or abs(p[1] - pts[-1][1]) > 1e-9:
            pts.append(p)

    def note_start(p):
        nonlocal breaks
        if last_end is not None and (abs(p[0] - last_end[0]) > 0.05 or abs(p[1] - last_end[1]) > 0.05):
            breaks += 1

    for it in items:
        kind = it[0]
        if kind == "l":
            a, b = (it[1].x, it[1].y), (it[2].x, it[2].y)
            note_start(a)
            add(a)
            add(b)
            last_end = b
        elif kind == "c":
            p0, p1, p2, p3 = it[1], it[2], it[3], it[4]
            note_start((p0.x, p0.y))
            for s in range(steps + 1):
                t = s / steps
                u = 1 - t
                x = u**3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t**3 * p3.x
                y = u**3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t**3 * p3.y
                add((x, y))
            last_end = (p3.x, p3.y)
        elif kind == "qu":
            # PyMuPDF의 'qu'는 사각형 4점(quad)으로 오기도 하고 2차 베지어로 오기도
            # 한다. 점 개수로 구분한다.
            pt = it[1:]
            if len(pt) == 3:  # 2차 베지어: 시작·제어·끝
                p0, p1, p2 = pt
                note_start((p0.x, p0.y))
                for s in range(steps + 1):
                    t = s / steps
                    u = 1 - t
                    x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x
                    y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
                    add((x, y))
                last_end = (p2.x, p2.y)
            else:
                q = pt[0]
                for p in (q.ul, q.ur, q.lr, q.ll, q.ul):
                    add((p.x, p.y))
                last_end = (q.ul.x, q.ul.y)
        elif kind == "re":
            r = it[1]
            for p in ((r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)):
                add(p)
            last_end = (r.x0, r.y0)
        else:
            unknown.add(kind)

    if unknown and strict:
        raise SystemExit(
            f"경로에 처리하지 못한 아이템이 있습니다: {sorted(unknown)}. "
            f"그대로 두면 해당 구간이 조용히 누락됩니다."
        )
    return pts, breaks


def split_subpaths(pts, factor=8.0, floor=5.0):
    """
    폴리라인을 끊긴 지점에서 여러 조각으로 나눈다.

    TDS마다 곡선을 담는 방식이 다르다. Kodak 최신판은 곡선 하나가 경로 하나지만,
    Vericolor III(E-26)는 **R/G/B 세 곡선이 경로 2개 안에 뭉쳐** 있다.
    쪼개지 않으면 곡선 후보가 2개로 잡혀 추출이 통째로 실패한다.

    ⚠️ 절대 거리로 자르면 안 된다. 곡선 위 이웃 점은 2~3pt씩 떨어져 있어서,
    작은 임계값(0.6pt)을 쓰면 **모든 점이 각각 조각이 된다**(실제로 220점이
    220조각이 됐다). 실제 단절은 일반 간격의 수십 배다 — Vericolor III는
    이웃 간격 2~3pt에 단절 166pt였다. 그래서 **중앙값 대비 배수**로 자른다.
    """
    if len(pts) < 2:
        return [pts] if pts else []
    steps = [max(abs(b[0] - a[0]), abs(b[1] - a[1])) for a, b in zip(pts, pts[1:])]
    ordered = sorted(steps)
    median = ordered[len(ordered) // 2] or 0.0
    threshold = max(median * factor, floor)

    out, cur = [], [pts[0]]
    for (a, b), step in zip(zip(pts, pts[1:]), steps):
        if step > threshold:
            out.append(cur)
            cur = [b]
        else:
            cur.append(b)
    out.append(cur)
    return out


def find_curves(draws, region, min_pts=20):
    """점이 많은 스트로크 경로 = 곡선 후보. 뭉친 경로는 서브패스로 쪼갠다."""
    out = []
    for i, d in enumerate(draws):
        r = d["rect"]
        if not region.intersects(r):
            continue
        if not d.get("width"):
            continue  # 채우기만 하는 경로(배경 상자 등)는 곡선이 아니다
        raw, breaks = flatten(d["items"])

        # 한 경로에 곡선이 여러 개 들어 있으면 쪼갠다.
        pieces = split_subpaths(raw)
        if len(pieces) > 1:
            for k, piece in enumerate(pieces):
                if len(piece) < min_pts:
                    continue
                bt = sum(1 for a, b in zip(piece, piece[1:]) if b[0] < a[0] - 1e-9)
                xs = [p[0] for p in piece]
                ys = [p[1] for p in piece]
                out.append({
                    "idx": f"{i}.{k}", "pts": sorted(piece, key=lambda p: p[0]),
                    "rect": fitz.Rect(min(xs), min(ys), max(xs), max(ys)),
                    "breaks": 0, "backtracks": bt, "rawPoints": len(piece),
                })
            continue

        pts, breaks = raw, breaks
        if len(pts) < min_pts:
            continue
        # 정렬 **전에** 원본 순서에서 x가 되돌아가는 구간을 센다. 정렬 후에는
        # 순서가 이미 파괴돼 되돌아감을 알아낼 수단이 없다.
        backtracks = sum(1 for a, b in zip(pts, pts[1:]) if b[0] < a[0] - 1e-9)
        ordered = sorted(pts, key=lambda p: p[0])
        out.append({"idx": i, "pts": ordered, "rect": r,
                    "breaks": breaks, "backtracks": backtracks, "rawPoints": len(pts)})
    return out


def find_frame(draws, region, curves):
    """
    플롯 프레임을 찾는다.

    TDS마다 프레임 그리는 방식이 다르다 — Portra(E-4050)는 선분 4개,
    Gold(E-7022)는 사각형 하나다. 그래서 두 형태를 모두 후보로 모은 뒤,
    **곡선 전체를 감싸는 가장 작은 상자**를 고른다. 배경용 큰 흰 상자가
    함께 잡혀도 이 기준이 걸러낸다.
    """
    cands = []

    # (a) 사각형 경로
    for d in draws:
        for it in d["items"]:
            if it[0] == "re":
                r = it[1]
                if region.intersects(r) and r.width > 40 and r.height > 40:
                    cands.append((r.x0, r.y0, r.x1, r.y1))

    # (b) 긴 수평/수직 선분 2쌍
    hori, vert = [], []
    for d in draws:
        for it in d["items"]:
            if it[0] != "l":
                continue
            p, q = it[1], it[2]
            if not (region.x0 <= p.x <= region.x1 and region.y0 <= p.y <= region.y1):
                continue
            if abs(p.y - q.y) < 0.2 and abs(p.x - q.x) > 40:
                hori.append((abs(q.x - p.x), p.y))
            elif abs(p.x - q.x) < 0.2 and abs(p.y - q.y) > 40:
                vert.append((abs(q.y - p.y), p.x))
    hori.sort(reverse=True)
    vert.sort(reverse=True)
    if len(hori) >= 2 and len(vert) >= 2:
        ys = sorted(h[1] for h in hori[:2])
        xs = sorted(v[1] for v in vert[:2])
        cands.append((xs[0], ys[0], xs[1], ys[1]))

    if not cands:
        raise SystemExit("프레임 후보를 찾지 못했습니다")

    # 곡선 전체를 담는 가장 작은 상자
    cx0 = min(c["rect"].x0 for c in curves)
    cy0 = min(c["rect"].y0 for c in curves)
    cx1 = max(c["rect"].x1 for c in curves)
    cy1 = max(c["rect"].y1 for c in curves)
    tol = 1.0

    fits = [c for c in cands
            if c[0] <= cx0 + tol and c[1] <= cy0 + tol and c[2] >= cx1 - tol and c[3] >= cy1 - tol]
    if not fits:
        raise SystemExit(f"곡선({cx0:.1f},{cy0:.1f})-({cx1:.1f},{cy1:.1f})을 감싸는 프레임이 없습니다")
    fits.sort(key=lambda c: (c[2] - c[0]) * (c[3] - c[1]))
    return fits[0]  # left, top, right, bottom


# 축 라벨의 부호 문자는 제조사마다 다르다.
#   Kodak  : ASCII 하이픈 '-'
#   Agfa   : EN DASH '–' (U+2013), 양수에는 '+' 접두
#   그 밖에: MINUS SIGN '−' (U+2212), FIGURE DASH '‒'
# 하나라도 놓치면 그 라벨이 통째로 무시돼 축 범위가 틀어진다.
DASHES = "-‐‑‒–—−"
NUMBER = re.compile(r"^[" + DASHES + r"+]?\d+(\.\d+)?$")


def norm_number(s):
    """축 라벨 문자열을 부호가 정규화된 숫자 문자열로. 숫자가 아니면 None."""
    if not NUMBER.match(s):
        return None
    body = s
    neg = False
    if body[0] in DASHES:
        neg, body = True, body[1:]
    elif body[0] == "+":
        body = body[1:]
    return ("-" if neg else "") + body


def find_overbar_strokes(draws, frame):
    """
    오버바 마이너스 후보 — x축 라벨 바로 위의 짧은 수평 획.

    Gold(E-7022)는 음수를 하이픈이 아니라 숫자 위 가로줄로 조판한다. 그 획은
    PDF에 벡터로 실재하므로(예: y=291.78, 길이 2.92pt, 라벨 윗변 1.41pt 위)
    추측하지 말고 직접 읽는다.
    """
    left, top, right, bottom = frame
    out = []
    for d in draws:
        for it in d["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if abs(a.y - b.y) > 0.3:
                continue
            length = abs(b.x - a.x)
            if not (1.0 <= length <= 9.0):
                continue
            # 축 라벨이 놓이는 띠 안에서만 찾는다
            if not (bottom < a.y < bottom + 25 and left - 25 < a.x < right + 25):
                continue
            out.append((min(a.x, b.x), max(a.x, b.x), a.y))
    return out


def overbar_over(bbox, strokes, gap=5.0):
    """라벨 상자 바로 위에 가로로 겹치는 획이 있는가."""
    x0, y0, x1, _ = bbox
    for sx0, sx1, sy in strokes:
        if not (y0 - gap <= sy <= y0):
            continue
        overlap = min(sx1, x1) - max(sx0, x0)
        if overlap > 0.5 * (sx1 - sx0):
            return True
    return False


def check_axis_against_ticks(draws, frame, axis, vmin, vmax, skip_paths=(), tol=0.02):
    """
    축 보정을 눈금 좌표로 검산한다.

    프레임 양끝을 축의 최소/최대 라벨값에 못박는 방식은 **최외곽 라벨이 프레임
    모서리에 있을 때만** 맞다. 축이 마지막 눈금 너머까지 연장된 플롯에서는
    선형 스케일이 조용히 틀어진다. 눈금은 등간격이므로 그것으로 검산한다.

    ⚠️ 곡선 경로는 반드시 제외한다. Gold 200은 세 곡선이 프레임 좌변에서 정확히
    시작하는데, 그 평평한 왼쪽 끝이 축 눈금과 똑같이 "좌변에서 짧게 뻗은 수평
    획"으로 보인다. 실제로 y축 눈금 3개에 곡선 끝 2개가 섞여 들어와 허위 경고가
    났다. 어느 경로가 곡선인지는 이미 알고 있으므로 그대로 걸러낸다.

    돌려주는 값은 (눈금 수, 최대 잔차[축 단위]). 판정 불가면 (n, None).
    """
    left, top, right, bottom = frame
    skip = set(skip_paths)
    ticks = []
    for i, d in enumerate(draws):
        if i in skip:
            continue
        for it in d["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if axis == "x":
                # 아래 축에서 위로 짧게 뻗은 수직 눈금
                if abs(a.x - b.x) < 0.2 and 2 <= abs(a.y - b.y) <= 10:
                    if abs(max(a.y, b.y) - bottom) < 2 and left < a.x < right:
                        ticks.append(a.x)
            else:
                # 왼쪽 축에서 오른쪽으로 짧게 뻗은 수평 눈금
                if abs(a.y - b.y) < 0.2 and 2 <= abs(a.x - b.x) <= 10:
                    if abs(min(a.x, b.x) - left) < 2 and top < a.y < bottom:
                        ticks.append(a.y)

    ticks = sorted(set(round(t, 3) for t in ticks))
    if len(ticks) < 3:
        return len(ticks), None

    gaps = [ticks[i + 1] - ticks[i] for i in range(len(ticks) - 1)]
    step = sum(gaps) / len(gaps)
    if step <= 0 or max(abs(g - step) for g in gaps) / step > 0.02:
        sys.stderr.write(
            f"경고: {axis}축 눈금 간격이 균일하지 않습니다 {[round(g, 2) for g in gaps]}. "
            f"눈금 검출에 눈금 아닌 획이 섞였을 수 있어 검산을 건너뜁니다.\n"
        )
        return len(ticks), None

    lo, hi = (left, right) if axis == "x" else (bottom, top)
    span = hi - lo
    if abs(span) < 1e-6:
        return len(ticks), None

    per_pt = (vmax - vmin) / span          # 1pt가 몇 축 단위인가
    step_units = abs(step * per_pt)        # 눈금 하나가 몇 축 단위인가

    # 프레임 끝(lo)에서 각 눈금까지가 눈금 간격의 정수배여야 한다.
    worst = 0.0
    for t in ticks:
        n = (t - lo) / step
        worst = max(worst, abs(n - round(n)) * step_units)

    if worst > tol:
        sys.stderr.write(
            f"경고: {axis}축 보정이 눈금과 {worst:.4f} 단위 어긋납니다 "
            f"(눈금 {len(ticks)}개, 간격 {step_units:.3f} 단위). 최외곽 라벨이 프레임 "
            f"모서리에 없는 플롯일 수 있으니 결과를 확인하십시오.\n"
        )
    return len(ticks), round(worst, 5)


def axis_values(words, frame, axis, draws=None, region=None):
    """
    축 라벨에서 눈금값을 읽는다. (위치, 값) 목록을 위치 오름차순으로 돌려준다.

    ⚠️ `region`을 반드시 넘길 것. 한 페이지에 플롯이 여러 개면 **이웃 플롯의 라벨이
    새어 들어온다.** Agfa 문서는 한 페이지에 필름 3종이 나란히 놓이는데, 왼쪽 열의
    x축 라벨이 가운데 열의 y축 라벨로 잡혀 농도축이 [1.0, 4.0]으로 틀어졌다
    (실제로는 [0.0, 4.0]). 프레임만으로는 이 둘을 가를 수 없다 — 호출자가 준
    영역이 곧 "이 플롯의 이웃"이므로 그것으로 자른다.
    """
    left, top, right, bottom = frame
    vals = []  # (위치, 값, 원문, bbox)
    for w in words:
        s = norm_number(w[4])
        if s is None:
            continue
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        bbox = (w[0], w[1], w[2], w[3])
        if region is not None and not (
            region.x0 - 5 < cx < region.x1 + 5 and region.y0 - 5 < cy < region.y1 + 5
        ):
            continue
        # 중심점으로 나누면 y축 '0.0'과 x축 '-4.0'이 프레임 모서리에서 서로 섞인다.
        # 라벨 상자 전체가 프레임 밖 어느 쪽에 있는지로 판별한다.
        if axis == "x":
            # 상자의 윗변이 프레임 바로 아래에 있어야 x축 라벨.
            # 상한을 두지 않으면 페이지 아래쪽 분광감도 차트의 파장 라벨(350~750)이
            # 섞여 들어와 축 범위가 통째로 망가진다.
            if bottom < w[1] < bottom + 25 and left - 20 < cx < right + 20:
                vals.append((cx, float(s), s, bbox))
        else:
            # 상자의 오른변이 프레임 왼쪽에 있어야 y축 라벨
            if w[2] < left and top - 15 < cy < bottom + 15:
                vals.append((cy, float(s), s, bbox))
    if len(vals) < 2:
        raise SystemExit(f"{axis}축 라벨을 찾지 못했습니다")
    vals.sort()

    # y축(농도)에는 부호 복원이 필요 없다. 화면 좌표는 아래로 증가하므로 위에서부터
    # 4.0 → 0.0으로 **정상적으로 감소**하는데, 이를 뒤집힌 것으로 오판하면
    # 농도가 전부 음수가 된다.
    if axis != "x":
        return [(p, v) for p, v, _, _ in vals]

    # --- 음수 부호 복원 ---------------------------------------------------
    #
    # Gold(E-7022)는 마이너스를 숫자 위 가로줄(오버바)로 조판해서 텍스트 추출에
    # 부호가 안 잡힌다 — '-3.0'이 '3.0'으로 읽힌다. 그대로 두면 축이 뒤집혀
    # 좌표 변환이 통째로 망가진다(실제로 logE가 [3.0, 1.0]으로 나왔다).
    #
    # **오버바 획을 직접 읽는다.** 처음엔 "최솟값 이전을 음수로" 하는 단조
    # 휴리스틱을 썼는데, 축 라벨이 전부 음수인 플롯([4,3,2,1] = -4..-1)에서
    # [-4,-3,-2,+1]을 만들고도 단조 조건을 통과해 **조용히 틀린다**.
    # 축 폭이 3.0이어야 하는데 5.0이 되어 모든 값이 1.67배로 왜곡된다.
    # 오버바는 PDF에 짧은 수평 획으로 실재하므로 추측할 이유가 없다.
    #
    # 원문에 이미 하이픈 부호가 있으면(Portra) 그것을 그대로 믿는다.
    # 여기서 abs()를 씌우면 멀쩡한 음수 축이 통째로 뒤집힌다.
    strokes = find_overbar_strokes(draws, frame) if draws else []
    signed = []
    for pos, v, raw, bbox in vals:
        if raw.startswith("-"):
            signed.append((pos, v))
        elif strokes and overbar_over(bbox, strokes):
            signed.append((pos, -abs(v)))
        else:
            signed.append((pos, abs(v)))

    seq = [v for _, v in signed]
    if all(seq[i + 1] > seq[i] for i in range(len(seq) - 1)):
        return signed

    # 위치는 등간격인데 값만 어긋난 경우 — PDF 텍스트 레이어의 오류다.
    #
    # Portra 800(E-4040) 4쪽 좌측 플롯이 그렇다. 라벨 위치는 37pt 등간격인데
    # 값이 -4.0, -2.0, -3.0, -1.0, 0.0, 1.0으로 2·3번이 뒤바뀌어 추출된다.
    # 그림 자체는 멀쩡하고 텍스트 레이어만 틀렸다. 이 검사가 없으면 해당 플롯이
    # 통째로 거부되고, 같은 페이지의 **증감현상(push) 곡선**이 대신 선택되어
    # 조용히 엉뚱한 데이터가 나온다(실제로 그렇게 됐다).
    #
    # 위치가 등간격이고 값들이 등차수열의 순열이면 순서를 바로잡는다.
    pos = [p for p, _ in signed]
    gaps = [pos[i + 1] - pos[i] for i in range(len(pos) - 1)]
    if len(gaps) >= 2:
        step = sum(gaps) / len(gaps)
        even = step > 0 and max(abs(g - step) for g in gaps) / step < 0.05
        srt = sorted(seq)
        vgaps = [srt[i + 1] - srt[i] for i in range(len(srt) - 1)]
        vstep = sum(vgaps) / len(vgaps) if vgaps else 0
        arithmetic = vstep > 0 and max(abs(g - vstep) for g in vgaps) / vstep < 0.05
        if even and arithmetic and srt != seq:
            sys.stderr.write(
                f"경고: x축 라벨 위치는 등간격인데 값 순서가 어긋납니다 {seq} → {srt}. "
                f"PDF 텍스트 레이어 오류로 보고 정렬했습니다. 플롯을 눈으로 확인하십시오.\n"
            )
            return [(pos[i], srt[i]) for i in range(len(pos))]

    # 오버바를 못 찾은 조판이면 단조 휴리스틱으로 물러선다. 조용히 틀릴 수 있으므로
    # 반드시 경고를 남긴다.
    raw_vals = [v for _, v, _, _ in vals]
    m = raw_vals.index(min(raw_vals))
    fixed = [-abs(v) if i < m else abs(v) for i, v in enumerate(raw_vals)]
    if all(fixed[i + 1] > fixed[i] for i in range(len(fixed) - 1)):
        sys.stderr.write(
            f"경고: x축 오버바를 찾지 못해 단조 휴리스틱으로 부호를 추정했습니다 "
            f"({raw_vals} → {fixed}). 축 라벨이 전부 음수인 플롯이면 이 추정이 "
            f"틀릴 수 있으니 결과를 반드시 눈으로 확인하십시오.\n"
        )
        return [(vals[i][0], fixed[i]) for i in range(len(vals))]
    raise SystemExit(f"x축 라벨 부호를 정할 수 없습니다: {raw_vals}")


def main():
    """
    사용법:
      extract_tds_curves.py <pdf> <페이지> <x0> <y0> <x1> <y1> [필름종류]

    필름종류: negative(기본) | reversal
      리버설은 오렌지 마스크가 없어 층 순서 불변식을 적용하지 않는다.
    """
    pdf, pageno = sys.argv[1], int(sys.argv[2])
    rx0, ry0, rx1, ry1 = map(float, sys.argv[3:7])
    region = fitz.Rect(rx0, ry0, rx1, ry1)
    film_type = sys.argv[7] if len(sys.argv) > 7 else "negative"

    doc = fitz.open(pdf)
    page = doc[pageno - 1]
    draws = page.get_drawings()
    words = page.get_text("words")

    curves = find_curves(draws, region)
    if len(curves) < 3:
        raise SystemExit(f"곡선 후보가 {len(curves)}개뿐입니다 (3개 필요)")
    left, top, right, bottom = find_frame(draws, region, curves)

    xlab = axis_values(words, (left, top, right, bottom), "x", draws, region)
    ylab = axis_values(words, (left, top, right, bottom), "y", None, region)
    # 라벨은 위치가 살짝 어긋나므로 값의 범위만 쓰고, 위치는 프레임을 신뢰한다.
    xmin, xmax = xlab[0][1], xlab[-1][1]
    ymax, ymin = ylab[0][1], ylab[-1][1]  # y는 위가 큰 값

    # 프레임 기반 매핑을 눈금으로 검산한다 (어긋나면 stderr 경고).
    # 곡선 경로는 제외 — 곡선의 평평한 끝이 축 눈금으로 오인된다.
    curve_ids = [c["idx"] for c in curves]
    frame_t = (left, top, right, bottom)
    nx, resx = check_axis_against_ticks(draws, frame_t, "x", xmin, xmax, curve_ids)
    ny, resy = check_axis_against_ticks(draws, frame_t, "y", ymin, ymax, curve_ids)

    def to_data(px, py):
        h = xmin + (px - left) * (xmax - xmin) / (right - left)
        d = ymin + (bottom - py) * (ymax - ymin) / (bottom - top)
        return h, d

    # Log H Ref
    text = page.get_text()
    m = re.search(r"Log\s*H\s*Ref[:\s]*(-?\d+(?:\.\d+)?)", text)
    log_h_ref = float(m.group(1)) if m else None

    # 프레임 밖으로 삐져나온 후보는 곡선이 아니다 (축 장식·범례 등)
    curves = [c for c in curves
              if c["rect"].x0 >= left - 2 and c["rect"].x1 <= right + 2
              and c["rect"].y0 >= top - 2 and c["rect"].y1 <= bottom + 2]
    if len(curves) < 3:
        raise SystemExit(f"프레임 안 곡선이 {len(curves)}개뿐입니다")

    # 라벨은 곡선 왼쪽 끝(Portra)일 수도 있고 곡선 중간(Gold)일 수도 있다.
    # 위치를 가정하지 말고 프레임 안의 R/G/B 글자를 모두 모은다.
    # 층 이름 표기가 제조사마다 다르다 — Kodak은 'R'/'G'/'B' 한 글자,
    # Agfa는 'Red'/'Green'/'Blue' 전체 단어를 쓴다.
    CH_WORDS = {"R": "R", "G": "G", "B": "B",
                "Red": "R", "Green": "G", "Blue": "B",
                "RED": "R", "GREEN": "G", "BLUE": "B"}
    labels = {}
    for w in words:
        ch = CH_WORDS.get(w[4])
        if ch:
            cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
            if left - 20 < cx < right and top < cy < bottom:
                labels[ch] = (cx, cy)

    # 라벨에서 각 곡선까지의 **최근접 거리**로 배정한다. 라벨이 곡선 어디에 놓여도
    # 동작하고, 한 곡선이 두 층에 배정되는 것을 막기 위해 가까운 쌍부터 확정한다.
    pairs = []
    for ch, (lx, ly) in labels.items():
        for c in curves:
            d2 = min((px - lx) ** 2 + (py - ly) ** 2 for px, py in c["pts"])
            pairs.append((d2**0.5, ch, c["idx"], c))
    pairs.sort(key=lambda t: t[0])

    assigned, usedCh, usedCurve = {}, set(), set()
    for dist, ch, idx, c in pairs:
        if ch in usedCh or idx in usedCurve:
            continue
        assigned[ch] = c
        usedCh.add(ch)
        usedCurve.add(idx)
    out_dists = {ch: round(next(p[0] for p in pairs if p[1] == ch and p[2] == assigned[ch]["idx"]), 2)
                 for ch in assigned}

    # 배정 여유 — 정답 쌍과 차순위 후보의 거리 차. 작으면 뒤바뀌기 쉽다는 뜻이다.
    margins = {}
    for ch in assigned:
        mine = next(p[0] for p in pairs if p[1] == ch and p[2] == assigned[ch]["idx"])
        others = [p[0] for p in pairs if p[1] == ch and p[2] != assigned[ch]["idx"]]
        margins[ch] = round(min(others) - mine, 2) if others else None

    # --- 물리 불변식 검사 -------------------------------------------------
    #
    # 최근접 거리 그리디만으로는 라벨이 두 곡선 사이에 놓이면 층이 뒤바뀔 수 있고,
    # 뒤바뀌어도 아무 경고가 없다. 컬러 네거티브는 오렌지 마스크 때문에 화면
    # 위에서부터 반드시 B > G > R 순서이므로(농도 B가 최대), 이것으로 확정 검증한다.
    # y는 화면 좌표라 위가 작다 — 즉 B의 y가 가장 작아야 한다.
    #
    # ⚠️ **리버설에는 적용하지 않는다.** 슬라이드는 오렌지 마스크가 없어 층 순서가
    # 보장되지 않는다. Agfachrome RSX II 50이 실제로 이 검사에 걸렸는데, 층 배정이
    # 틀린 게 아니라 검사 전제가 컬러 네거티브 전용이었던 것이다.
    # 라벨 3개 확보는 종류와 무관하게 필수다.
    if len(assigned) != 3:
        raise SystemExit(f"R/G/B 라벨을 3개 모두 찾지 못했습니다: {sorted(assigned)}")

    if film_type != "reversal":
        ys = {ch: sum(p[1] for p in assigned[ch]["pts"]) / len(assigned[ch]["pts"])
              for ch in ("R", "G", "B")}
        if not (ys["B"] < ys["G"] < ys["R"]):
            raise SystemExit(
                "층 배정이 물리 불변식을 어깁니다 — 컬러 네거티브는 위에서부터 "
                f"B > G > R 이어야 하는데 평균 y가 B={ys['B']:.1f} G={ys['G']:.1f} "
                f"R={ys['R']:.1f} 입니다. 라벨-곡선 매칭을 확인하십시오."
            )

    out = {
        "pdf": pdf.split("\\")[-1],
        "page": pageno,
        "frame": {"left": left, "top": top, "right": right, "bottom": bottom},
        "axis": {"logE": [xmin, xmax], "density": [ymin, ymax]},
        "logHRef": log_h_ref,
        "labels": {k: [round(v[0], 2), round(v[1], 2)] for k, v in labels.items()},
        "labelMatchDistance": out_dists,
        "labelMatchMargin": margins,
        "axisTickCheck": {"x": {"ticks": nx, "maxResidual": resx},
                          "y": {"ticks": ny, "maxResidual": resy}},
        "curves": {},
    }

    for ch in ("r", "g", "b"):
        c = assigned.get(ch.upper())
        if not c:
            out["curves"][ch] = None
            continue
        data = [to_data(x, y) for x, y in c["pts"]]
        # x 단조 보장 (겹치는 점 제거)
        clean = []
        for h, dd in data:
            if not clean or h > clean[-1][0] + 1e-6:
                clean.append((h, dd))
        dropped = c["rawPoints"] - len(clean)
        if dropped or c["breaks"] or c["backtracks"]:
            sys.stderr.write(
                f"주의: {ch.upper()} 곡선(path {c['idx']}) — 원본 {c['rawPoints']}점 중 "
                f"{dropped}점 제거, 서브패스 단절 {c['breaks']}회, "
                f"x 되돌아감 {c['backtracks']}회.\n"
            )
        out["curves"][ch] = {
            "pathIndex": c["idx"],
            "nPoints": len(clean),
            "rawPoints": c["rawPoints"],
            "droppedPoints": dropped,
            "subpathBreaks": c["breaks"],
            "xBacktracks": c["backtracks"],
            "logERange": [round(clean[0][0], 4), round(clean[-1][0], 4)],
            "densityRange": [round(min(p[1] for p in clean), 4), round(max(p[1] for p in clean), 4)],
            "points": [[round(h, 5), round(dd, 5)] for h, dd in clean],
        }

        # 곡선이 프레임 가장자리에서 시작/종료하면 잘린 것이다 — 그 끝점 농도는
        # Dmin이 아니다. Gold 200이 이 경우이고, Dmin을 과대추정하게 된다.
        if abs(c["rect"].x0 - left) < 0.5 or abs(c["rect"].x1 - right) < 0.5:
            out["curves"][ch]["clippedAtFrame"] = True

    print(json.dumps(out, indent=1))
    doc.close()


# import 해서 개별 함수를 검증할 수 있도록 가드를 둔다.
if __name__ == "__main__":
    main()
