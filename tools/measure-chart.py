#!/usr/bin/env python3
"""24색 차트 브래킷으로 **ACR 역산이 색까지 되돌리는지** 잰다 — TODO N6의 판정 도구.

── 무엇을 비교하나 ────────────────────────────────────────────────────────

같은 raw를 두 길로 푼다.

  ACR  : Camera Raw "Adobe Standard" + 슬라이더 0 → ProPhoto 16bit TIFF
         → `core/color/inputs.js`의 입력 decode(`acr-standard` 또는 `prophoto`)
  libraw: `tools/decode-raw.py`의 `load_linear` (톤 커브·HueSatMap 없음, 선형)

둘을 패치별 Lab(ΔL·ΔC·Δh·ΔE)으로 대조한다. 무채색이 맞으면 톤 역산(조건 b)은 맞다.

⚠️ **libraw는 정답이 아니다** — 다른 보정(dcraw 단일 광원 ColorMatrix)일 뿐이라 Adobe
보정(ForwardMatrix + HueSatMap)과 유채색에서 ΔE 7 안팎 갈린다. 이 도구는 **톤과
색상각**을 보는 데 쓰고, 채도 판정은 ACR이 직접 그린 렌더로 한다(docs/RESOLVED.md
"「원인 ②」는 결함이 아니었다").

스케일 하나(022 중간 회색, G, 0스톱)만 맞춘다. 채널별로 따로 맞추면 보려는 그
차이를 지워 버린다.

⚠️ 차트 공칭값(chartinfo.ARW)은 쓰지 않는다 — 조명·Lab 없는 sRGB 8bit 복제품
값이라 정답이 못 된다. 같은 raw의 두 현상끼리만 비교한다.

사용법:
    python tools/measure-chart.py TIFF_DIR RAW_DIR [--grid x1,y1,x24,y24] [--box 320]

TIFF는 RAW와 같은 이름(접미사 `-2` 등 허용), 상대 스톱은 xmp의 ExposureBiasValue에서 읽는다.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
decode_raw = __import__("decode-raw")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEUTRAL = range(18, 24)  # 019~024
REF_PATCH = 21           # 022 중간 회색
NAMES = [
    "진한피부", "밝은피부", "하늘", "잎", "보라꽃", "청록",
    "주황", "군청", "분홍", "보라", "황록", "주황노랑",
    "파랑", "초록", "빨강", "노랑", "마젠타", "시안",
    "흰", "회백", "밝은회색", "중간회색", "진한회색", "검정",
]


def decode_table(input_id, n=4097):
    """inputs.js의 decode를 그대로 표로 뽑는다 — 파이썬으로 다시 짜면 조용히 어긋난다."""
    js = (
        f"const i=require('./core/color/inputs').byId('{input_id}');"
        f"const o=[];for(let k=0;k<{n};k++)o.push(i.decode(k/{n - 1}));"
        "process.stdout.write(JSON.stringify(o))"
    )
    out = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return np.array(json.loads(out.stdout))


def stop_of(raw_path):
    xmp = open(os.path.splitext(raw_path)[0] + ".xmp", encoding="utf-8").read()
    n, d = re.search(r'exif:ExposureBiasValue="(-?\d+)/(\d+)"', xmp).groups()
    return int(n) / int(d)


def centers(grid):
    """001 중심과 024 중심으로 6×4 격자."""
    x1, y1, x24, y24 = grid
    xs = np.linspace(x1, x24, 6)
    ys = np.linspace(y1, y24, 4)
    return [(int(x), int(y)) for y in ys for x in xs]


def patch_median(img, cx, cy, box):
    h = box // 2
    return np.median(img[cy - h:cy + h, cx - h:cx + h].reshape(-1, 3), axis=0)


def measure(tiff_dir, raw_dir, grid, box):
    import rawpy
    import tifffile

    pts = centers(grid)
    rows = []  # (stop, acr_v[24,3], raw_lin[24,3])
    for raw_path in sorted(glob.glob(os.path.join(raw_dir, "*.ARW"))):
        base = os.path.splitext(os.path.basename(raw_path))[0]
        tifs = glob.glob(os.path.join(tiff_dir, base + "*.tif"))
        if not tifs:
            continue
        stop = stop_of(raw_path)
        v = tifffile.imread(tifs[0]).astype(np.float64) / 65535.0
        acr = np.array([patch_median(v, x, y, box) for x, y in pts])
        del v
        lin = decode_raw.load_linear(raw_path)
        with rawpy.imread(raw_path) as r:  # ACR TIFF는 crop 영역만 — 좌표를 옮긴다
            dx, dy = r.sizes.crop_left_margin, r.sizes.crop_top_margin
        rl = np.array([patch_median(lin, x + dx, y + dy, box) for x, y in pts])
        del lin
        rows.append((stop, acr, rl))
        sys.stderr.write(f"  {base} {stop:+.1f}스톱\n")
    return sorted(rows, key=lambda r: r[0])


def engine_decode(input_id):
    """엔진의 코드 재배치(`inputs.remapCodes`, 색상 보존 역) 뒤 채널별 decode를 그대로
    부른다. 측정과 엔진이 같은 코드를 지나야 이 표가 엔진 결과를 대변한다."""
    def f(v):
        js = (
            f"const I=require('./core/color/inputs'),i=I.byId('{input_id}'),"
            "m=I.remapCodes(i),o=new Float64Array(3);"
            "const a=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(a.map(([r,g,b])=>(m(r,g,b,o),[...o].map(i.decode)))))"
        )
        flat = np.asarray(v, dtype=np.float64).reshape(-1, 3)
        out = subprocess.run(["node", "-e", js], cwd=ROOT, input=json.dumps(flat.tolist()),
                             capture_output=True, text=True, check=True)
        return np.array(json.loads(out.stdout)).reshape(np.shape(v))
    return f


PROPHOTO_TO_XYZ = np.array([  # ROMM, D50
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0, 0.0, 0.8252100],
])
D50 = np.array([0.96422, 1.0, 0.82521])


def lab(lin):
    xyz = lin @ PROPHOTO_TO_XYZ.T / D50
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def usable(acr, rl):
    return np.all((acr > 0.02) & (acr < 0.98) & (rl < 0.95) & (rl > 1e-4))


def report(rows, input_id, remap=False):
    table = decode_table(input_id)
    grid = np.linspace(0, 1, len(table))
    dec = lambda v: np.interp(v, grid, table)
    name = input_id
    if remap:
        dec = engine_decode(input_id)
        name += " (색상 보존 역 = 엔진)"

    s0 = next(r for r in rows if r[0] == 0)
    k = dec(s0[1][REF_PATCH])[1] / s0[2][REF_PATCH, 1]

    print(f"\n━━ {name} vs libraw — Lab(D50, 기준 그레이 0.18) · 스케일 1개(022·G·0스톱) ━━")
    print("ΔL 톤 차 · ΔC 채도 차(+면 ACR 쪽이 진함) · Δh 색상각 차(°) — 0스톱. 끝 열은 스톱별 ΔE(−4→+4, ·=클리핑)")
    print("패치            ΔL     ΔC     Δh     ΔE   스톱별 ΔE")
    de0 = {}
    for p in range(24):
        per_stop = []
        for s, acr, rl in rows:
            if not usable(acr[p], rl[p]):
                per_stop.append("  ·")
                continue
            A, R = lab(dec(acr[p])), lab(rl[p] * k)
            de = np.linalg.norm(A - R)
            per_stop.append(f"{de:3.0f}")
            if s == 0:
                cA, cR = np.hypot(*A[1:]), np.hypot(*R[1:])
                dh = (np.degrees(np.arctan2(A[2], A[1]) - np.arctan2(R[2], R[1])) + 180) % 360 - 180
                de0[p] = (A[0] - R[0], cA - cR, dh if cR > 5 else 0.0, de)
        if p in de0:
            dL, dC, dh, de = de0[p]
            print(f"{p + 1:03d} {NAMES[p]:<8} {dL:+6.1f} {dC:+6.1f} {dh:+6.1f} {de:6.1f}  " + " ".join(per_stop))
    neu = [de0[p][3] for p in NEUTRAL if p in de0]
    chro = [de0[p][3] for p in range(18) if p in de0]
    print(f"0스톱 ΔE — 무채색 중앙 {np.median(neu):.1f} / 유채색 중앙 {np.median(chro):.1f} · 최대 {max(chro):.1f}")


def fit_curve(rows, deg=3, shoulder=0.05):
    """`acr-standard` 톤 커브를 차트 무채색 패치에서 맞춘다 → `inputs.js`의 ACR_FIT.

    무채색 6패치 × 스톱 × 3채널의 (ACR 코드 v, libraw 선형) 쌍에 **ln v 축 3차 다항식
    + 어깨 항 −ln(1+ε−v)**를 맞춘다. 무채색이라 libraw의 행렬 차이가 거의 없고, 노출을
    따로 풀 필요도 없다(같은 raw의 선형값이 곧 정답). 어깨 항이 없으면 v>0.95에서
    0.3스톱씩 모자란다 — ACR 하이라이트 롤오프가 1 근처에서 급하게 휘어 다항식이 못 따라간다.

    ⚠️ 왜 Debevec(`derive-acr-curve.py`)을 안 쓰나: 그 결과는 국소 기울기가 0.85~6.75로
    출렁였다. 무채색은 세 채널이 같아 안 드러나지만, 채도는 g(v_max)−g(v_min)이라
    **기울기가 출렁이면 밝기에 따라 채도가 출렁인다** — 피부가 회색·분홍 얼룩으로
    갈라졌다(N6). 저차 다항식은 기울기가 매끄럽다는 것을 구성으로 보장한다.

    후보 비교(2026-10-07, 실사진 MDR03671 얼굴의 채도비 흩어짐 — 리니어 대비):
    Debevec 0.336 · 5차 0.136 · **3차+어깨 0.086** · 5차+어깨 0.083. 차수를 올려도
    나아지지 않아 가장 단순한 것을 쓴다.
    """
    v, lnL = [], []
    for _, acr, rl in rows:
        for p in NEUTRAL:
            for c in range(3):
                if 0.005 < acr[p, c] < 0.995 and 1e-5 < rl[p, c] < 0.95:
                    v.append(acr[p, c]); lnL.append(np.log(rl[p, c]))
    v, lnL = np.array(v), np.array(lnL)
    basis = lambda u: np.stack([np.log(u) ** k for k in range(deg + 1)] + [-np.log(1 + shoulder - u)], -1)
    coef, *_ = np.linalg.lstsq(basis(v), lnL, rcond=None)
    res = (lnL - basis(v) @ coef) / np.log(2)
    # 제어점이 아니라 **계수를 그대로** 싣는다 — 제어점을 pchip으로 다시 이으면
    # 기울기에 작은 출렁임(극값 5개)이 생겨 이 피팅을 한 이유가 사라진다.
    print(f"\n━━ 톤 커브 피팅 — 무채색 {len(v)}점, ln v 축 {deg}차 + 어깨 ε={shoulder}, "
          f"잔차 RMS {np.std(res):.3f}·최대 {np.abs(res).max():.3f}스톱 ━━")
    print("const ACR_FIT = {")
    print(f"  lo: {v.min():.4f}, // 실제 표본이 있던 최저 v — 그 아래는 ln v 축 직선 외삽")
    print(f"  shoulder: {shoulder},")
    print(f"  coef: [{', '.join(f'{c:.6f}' for c in coef)}], // ln v의 0~{deg}차, 마지막은 −ln(1+ε−v)")
    print("};")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tiff_dir")
    ap.add_argument("raw_dir")
    # 기본값은 N1braket/9stopwithcolor(2026-10-06) 촬영의 001·024 중심
    ap.add_argument("--grid", default="1704,1360,7600,4896")
    ap.add_argument("--box", type=int, default=320)
    ap.add_argument("--samples", help="패치 표본 npz — 있으면 읽고, 없으면 재서 저장(raw 재현상 생략)")
    ap.add_argument("--fit-curve", action="store_true", help="무채색 패치로 acr-standard 톤 커브 제어점을 맞춰 출력")
    a = ap.parse_args()
    if a.samples and os.path.exists(a.samples):
        z = np.load(a.samples)
        rows = list(zip(z["stops"].tolist(), z["acr"], z["raw"]))
    else:
        rows = measure(a.tiff_dir, a.raw_dir, [int(t) for t in a.grid.split(",")], a.box)
        if a.samples:
            np.savez(a.samples, stops=[r[0] for r in rows], acr=[r[1] for r in rows], raw=[r[2] for r in rows])
    if a.fit_curve:
        fit_curve(rows)
        return
    report(rows, "acr-standard")
    report(rows, "acr-standard", remap=True)
    report(rows, "prophoto")


if __name__ == "__main__":
    main()
