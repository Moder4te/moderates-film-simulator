#!/usr/bin/env python3
"""ACR(Camera Raw) 렌더링의 숨은 톤 커브를 **역산**한다 — `core/color/inputs.js`의
`acr-standard` 입력이 여기서 나왔다.

── 왜 필요한가 ────────────────────────────────────────────────────────────

`docs/RESOLVED.md`(2026-08-12) "ACR Adobe Standard도 조건 (b)를 만족하지 않는다"에서
실측으로 확인했다 — Camera Raw로 "Adobe Standard" 프로필 + 슬라이더 전부 0으로 현상해도
암부는 게인이 더 걸리고 하이라이트는 덜 걸리는 매끈한 S자 대비가 남는다. 그 결과
raw를 Camera Raw로 그냥 현상해 필름 엔진에 먹이면, 필름 곡선이 엉뚱한 입력 위에서 돈다.

이 도구는 그 커브를 **역산해 되돌리는** 함수를 만든다 — `tools/decode-raw.py`처럼
ACR을 건너뛰는 대신, ACR이 이미 무슨 짓을 했는지 알아내서 취소한다. 후처리 없이
Camera Raw로 곧장 현상한 파일을 그대로 먹일 수 있게 하는 것이 목적이다.

── 방법 — HDR 카메라 응답함수 복원과 같은 문제 ─────────────────────────────

입사식 노출계로 기준을 잡은 −2/−1/0/+1/+2스톱 브래킷(ISO만 바꿔 정확히 1스톱씩
뗀다)을 "Adobe Standard" + 슬라이더 0으로 현상하면, 같은 물리적 지점이 정확히 알려진
상대 노출 5개에서 어떻게 렌더링되는지 알 수 있다. 이건 Debevec–Malik(1997)의 HDR
카메라 응답함수 복원과 **똑같은 문제**다 — 다만 우리는 노출비를 추정할 필요 없이
ISO로 정확히 안다는 점이 더 쉽다.

    g(Z_ij) = ln(E_i) + ln(Δt_j)

Z_ij = 픽셀 i가 이미지 j에서 갖는 렌더링값, E_i = 그 픽셀의 (미지의) 씬 노광,
Δt_j = 이미지 j의 (기지의) 상대 노출. g(알고 싶은 것) · ln(E_i)(관심 없음, 그냥
버림) 를 최소자승으로 동시에 푼다. 여러 물리적 지점(각자 다른 E_i)의 관측을
합쳐야 g의 넓은 구간을 커버할 수 있다.

**조건 (a)(절대 앵커)는 여전히 못 잡는다** — g에 상수를 더하고 모든 ln(E_i)에서
같은 상수를 빼도 방정식이 그대로 성립하기 때문이다(위 식의 널스페이스). 그래서
`--anchor-v`로 지정한 코드값에서 g=0이 되도록 임의로 맞춘다(기본은 ProPhoto 18%
그레이 인코딩 0.3857 — 다른 입력들과 같은 관례). 이 앵커가 실제로 18% 그레이라는
보장은 없다 — 노출 슬라이더로 상쇄되는 부분이라 급하지 않다(조건 a는 항상 그렇다).

── 사용법 ──────────────────────────────────────────────────────────────────

    pip install numpy tifffile

    python tools/derive-acr-curve.py \\
        img_-2ev.tif:-2 img_-1ev.tif:-1 img_0ev.tif:0 img_+1ev.tif:1 img_+2ev.tif:2

브래킷은 3장 이상, 인접 스톱 간격이 균등할 필요는 없다(`:` 뒤에 실제 스톱을 적는다).
같은 정적 장면을 삼각대로, ISO만 바꿔 찍은 것이어야 한다(조리개·셔터·WB 고정).

`--selftest`로 raw 없이 자체 검산만 돌릴 수도 있다(과거 유도 결과를 재확인).
"""
import argparse
import sys


def load_linear_v(path):
    """16bit TIFF를 읽어 0~1 인코딩값으로. 채널 순서·심도는 건드리지 않는다."""
    import numpy as np
    import tifffile

    arr = tifffile.imread(path)
    if arr.dtype != np.uint16:
        raise SystemExit(f"{path}: 16bit TIFF가 아닙니다 ({arr.dtype})")
    return arr.astype(np.float64) / 65535.0


def sample_points(ref_v, n_strata, n_per_stratum, seed):
    """기준 프레임의 luma로 층화 표본 — 어둡고 밝은 영역을 골고루 담는다.

    무작위 픽셀을 그냥 뽑으면 씬의 대부분을 차지하는 중간톤에 표본이 몰려
    암부·명부 쪽 g(v) 추정이 부실해진다. 층화로 전 구간을 강제로 고르게 담는다.
    """
    import numpy as np

    rng = np.random.default_rng(seed)
    luma = ref_v.mean(axis=2)
    edges = np.quantile(luma, np.linspace(0, 1, n_strata + 1))
    ys, xs = [], []
    for i in range(n_strata):
        lo, hi = edges[i], edges[i + 1]
        mask = (luma >= lo) & (luma < hi if i < n_strata - 1 else luma <= hi)
        idx = np.argwhere(mask)
        if len(idx) == 0:
            continue
        pick = rng.choice(len(idx), size=min(n_per_stratum, len(idx)), replace=False)
        for p in idx[pick]:
            ys.append(p[0])
            xs.append(p[1])
    return np.array(ys), np.array(xs)


def gsolve(Zq, B, n_bins, l, w_fn):
    """Debevec–Malik 카메라 응답함수 복원 (Debevec & Malik 1997, Fig.5 `gsolve`).

    Zq: (표본 수, 이미지 수) 정수 bin 인덱스. B: 이미지별 ln(상대노출)(기지).
    l: 매끄러움 정칙화 강도. w_fn: bin 가중치(양끝은 SNR이 낮아 덜 믿는다).
    """
    import numpy as np

    n_samples, n_images = Zq.shape
    n = n_bins
    A = np.zeros((n_samples * n_images + n - 1 + 1, n + n_samples))
    b = np.zeros(A.shape[0])
    k = 0
    for i in range(n_samples):
        for j in range(n_images):
            z = Zq[i, j]
            wij = max(w_fn(z), 1e-6)
            A[k, z] = wij
            A[k, n + i] = -wij
            b[k] = wij * B[j]
            k += 1
    A[k, n // 2] = 1  # 널스페이스 제거 — 중간 bin을 0으로. 나중에 anchor로 재조정한다
    b[k] = 0
    k += 1
    for z in range(1, n - 1):
        wz = w_fn(z)
        A[k, z - 1] = l * wz
        A[k, z] = -2 * l * wz
        A[k, z + 1] = l * wz
        k += 1
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    return x[:n], x[n:]


def derive(specs, n_bins, n_strata, n_per_stratum, smoothness, anchor_v, seed):
    import numpy as np

    stops = [s for _, s in specs]
    imgs = {s: load_linear_v(p) for p, s in specs}
    # 층화 표본은 이 프레임의 luma로 뽑는다 — **입사식 노출계로 잡은 0스톱
    # 프레임**이어야 한다(노출계 기준점이지 "리스트 중간"이 아니다). 프레임을
    # 짝수 개 넘기면 len//2가 0스톱과 다른 인덱스를 골라 표본 위치가 통째로
    # 바뀐다(브래킷에 프레임을 추가/제거할 때마다 표본이 흔들려 재현성이 깨짐).
    ref_stop = 0 if 0 in stops else stops[len(stops) // 2]
    h, w, _ = imgs[ref_stop].shape
    for s, im in imgs.items():
        if im.shape != (h, w, 3):
            raise SystemExit(f"프레임 크기가 안 맞습니다: {s}스톱이 {im.shape}, 기준은 {(h, w, 3)}")

    ys, xs = sample_points(imgs[ref_stop], n_strata, n_per_stratum, seed)
    sys.stderr.write(f"표본 위치 {len(ys)}개 × RGB × {len(stops)}스톱\n")

    order = sorted(stops)
    Z = np.concatenate(
        [np.stack([imgs[s][ys, xs, ch] for s in order], axis=1) for ch in range(3)], axis=0
    )
    B = np.array(order, dtype=np.float64) * np.log(2)

    Zq = np.clip(np.round(Z * (n_bins - 1)).astype(int), 0, n_bins - 1)

    def w_fn(z):
        mid = (n_bins - 1) / 2.0
        return 1.0 - abs(z - mid) / mid

    sys.stderr.write("최소자승 푸는 중...\n")
    g, _lE = gsolve(Zq, B, n_bins, smoothness, w_fn)

    # 표본이 실제로 있던 구간만 신뢰한다 — 그 밖은 정칙화가 만든 외삽이다.
    counts = np.zeros(n_bins)
    for z in Zq.ravel():
        counts[z] += 1
    covered = np.where(counts > 0)[0]
    v_lo, v_hi = covered.min() / (n_bins - 1), covered.max() / (n_bins - 1)
    sys.stderr.write(f"표본 있는 범위: v={v_lo:.4f}~{v_hi:.4f}\n")

    # anchor_v에서 g=0이 되도록 재조정(조건 a — 임의 관례, 위 docstring 참조)
    g_anchor = float(np.interp(anchor_v, np.linspace(0, 1, n_bins), g))
    g = g - g_anchor

    return g, v_lo, v_hi, Z, order, np.linspace(0, 1, n_bins)


def to_control_points(g, zgrid, v_lo, v_hi, n_ctrl):
    import numpy as np

    v_ctrl = np.linspace(v_lo, v_hi, n_ctrl)
    g_ctrl = np.interp(v_ctrl, zgrid, g)
    return list(zip(v_ctrl.tolist(), g_ctrl.tolist()))


def validate(Z, order, g, zgrid):
    """왕복 검산 — 보정 후 스톱 간격이 인접 프레임 전부에서 1.0 가까이 모이는가."""
    import numpy as np

    def g_interp(v):
        return np.interp(v, zgrid, g)

    LOG2 = np.log(2)
    sys.stderr.write("\n── 왕복 검산 (인접 스톱 쌍, 보정 전 vs 보정 후 median) ──\n")
    for j in range(len(order) - 1):
        v0, v1 = Z[:, j], Z[:, j + 1]
        d_before = np.log2((v1 ** 1.8) / np.maximum(v0 ** 1.8, 1e-12))
        d_after = (g_interp(v1) - g_interp(v0)) / LOG2
        sys.stderr.write(
            f"  {order[j]:+.3f}→{order[j+1]:+.3f}stop  "
            f"보정 전={np.median(d_before):.3f}  보정 후={np.median(d_after):.3f}  "
            f"(표준편차 {np.std(d_after):.3f})\n"
        )


def selftest():
    """raw 없이: 이전 유도 결과(2026-08-13, inputs.js에 실린 값)의 형태만 재확인한다."""
    import math

    from importlib import import_module

    pts = [
        [0.05, -1.80403], [0.0984, -1.51398], [0.1468, -1.1803], [0.1953, -0.83682],
        [0.2437, -0.57047], [0.2921, -0.41474], [0.3405, -0.18295], [0.3889, 0.01315],
        [0.4374, 0.15624], [0.4858, 0.26552], [0.5342, 0.41245], [0.5826, 0.60821],
        [0.6311, 0.77926], [0.6795, 0.90119], [0.7279, 1.00947], [0.7763, 1.19859],
        [0.8247, 1.45569], [0.8732, 1.59291], [0.9216, 1.73742], [0.97, 1.90105],
    ]
    ok = True
    for i in range(1, len(pts)):
        if pts[i][1] <= pts[i - 1][1]:
            ok = False
            sys.stderr.write(f"❌ 단조 위반 @ v={pts[i][0]}\n")
    print(f"  {'OK  ' if ok else '❌  '}저장된 제어점 20개가 단조 증가")
    v_anchor = 0.3857
    g_anchor = None
    for i in range(1, len(pts)):
        if pts[i - 1][0] <= v_anchor <= pts[i][0]:
            t = (v_anchor - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])
            g_anchor = pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])
            break
    near_zero = g_anchor is not None and abs(g_anchor) < 0.05
    print(f"  {'OK  ' if near_zero else '❌  '}v=0.3857(ProPhoto 18% 그레이) 근방에서 g≈0  ({g_anchor:.4f})")
    ok = ok and near_zero
    print("\n✅ 전 항목 통과" if ok else "\n❌ 실패 항목 있음")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames", nargs="*", metavar="FILE:STOP", help="16bit TIFF:상대스톱 (예: a.tif:-1)")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--bins", type=int, default=256, help="g 조회 테이블 크기 (기본 256)")
    ap.add_argument("--strata", type=int, default=60, help="층화 표본 구간 수 (기본 60)")
    ap.add_argument("--per-stratum", type=int, default=12, help="구간당 표본 위치 수 (기본 12)")
    ap.add_argument("--smoothness", type=float, default=50.0, help="정칙화 강도 (기본 50)")
    ap.add_argument("--anchor-v", type=float, default=0.3857, help="g=0으로 고정할 v (기본 ProPhoto 18%% 그레이)")
    ap.add_argument("--ctrl-points", type=int, default=20, help="출력 제어점 수 (기본 20)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", help="제어점을 JSON으로도 저장")
    a = ap.parse_args()

    if a.selftest:
        sys.exit(selftest())
    if len(a.frames) < 3:
        ap.error("frames가 최소 3장 필요합니다 (FILE:STOP FILE:STOP ...)")

    specs = []
    for f in a.frames:
        if ":" not in f:
            ap.error(f"'{f}'에 :스톱이 없습니다 (예: img.tif:-1)")
        path, stop = f.rsplit(":", 1)
        specs.append((path, float(stop) if "." in stop else int(stop)))

    g, v_lo, v_hi, Z, order, zgrid = derive(
        specs, a.bins, a.strata, a.per_stratum, a.smoothness, a.anchor_v, a.seed
    )
    validate(Z, order, g, zgrid)

    ctrl = to_control_points(g, zgrid, v_lo, v_hi, a.ctrl_points)
    print("\n제어점 (core/color/inputs.js의 ACR_STANDARD_CTRL 형식):")
    for v, gg in ctrl:
        print(f"  [{v:.4f}, {gg:+.5f}],")

    if a.out:
        import json

        json.dump({"v_lo": v_lo, "v_hi": v_hi, "ctrl": ctrl}, open(a.out, "w"), indent=1)
        sys.stderr.write(f"\n저장: {a.out}\n")


if __name__ == "__main__":
    main()
