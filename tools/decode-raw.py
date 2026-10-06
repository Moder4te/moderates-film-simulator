#!/usr/bin/env python3
"""RAW → **톤 커브 없는 ProPhoto 16bit**. 엔진의 베이스를 측정이 아니라 구성으로 만든다.

── 왜 이게 있나 ────────────────────────────────────────────────────────

`docs/ARCHITECTURE.md` 「중립 현상이 정확히 무엇인가」의 조건 (b)는 "입력 전달함수가
감마 1.8 거듭제곱 하나뿐"이다. Camera Raw는 슬라이더를 전부 0으로 둬도 이걸 만족하지
않는다 — 카메라 프로필(DCP)에 베이스라인 톤 커브가 있고 `Adobe Color`는 그 위에 대비를
더 건다. 그 휨은 **노출 슬라이더로 못 편다**(실측: 입력 대비 1.10배 → 노출 최선 보정
뒤에도 암부 −3.3 / 하이라이트 +4.3, 8bit).

선형 DCP를 만들어 물리는 방법도 있지만, 프로필이 선형이라고 해서 ACR 파이프라인
전체가 선형이라는 보장은 없다(BaselineExposureOffset · DefaultBlackRender · 하이라이트
복원 등 프로필이 소유하지 않는 단계들). **여기서는 ACR을 건너뛴다** — libraw로 직접
풀면 전달함수가 측정 대상이 아니라 **구성상 알려진 값**이 된다.

── 헤드룸 ──────────────────────────────────────────────────────────────

톤 커브를 없애면 문제가 하나 생긴다: 0~1 통에 씬을 어디 놓을 것인가. 기준 그레이를
0.18에 두면 위로 **2.47스톱**뿐이라 하늘·창·스페큘러가 통째로 잘린다. 지우려는 그
베이스라인 톤 커브가 사고 있던 것이 정확히 그 범위다.

그래서 기준 그레이를 내려 담는다. 기본 **+5스톱** — 근거는 `core/color/inputs.js`의
`HEADROOMS` 주석에 실측 표로 있다(요약: +5 위로는 모델이 스톱당 3코드값 미만으로만
움직여 통이 잘라도 필름 롤오프와 구분되지 않고, +4에서 자르면 아직 살아 있는 계조
7.6~15.1을 디지털로 자르게 된다).

⚠️ **엔진에서 같은 헤드룸을 골라야 한다.** 이 도구가 `-h 5`로 뽑았으면 패널의
입력 소스를 「리니어 +5스톱」으로. 안 맞추면 통째로 노출이 밀린다. 도구가 끝에
무엇을 고르라고 찍어 준다.

⚠️ **눈으로 보면 어둡다.** +5스톱이면 기준 그레이가 8bit 37 수준이다. 이건 보는
파일이 아니라 **먹이는 파일**이고, 그래서 16bit가 필수다.

── 노광 기준 ───────────────────────────────────────────────────────────

libraw의 정규화는 **화이트 레벨** 기준이지 "씬의 18% 그레이" 기준이 아니다. 즉 이
도구가 놓는 자리는 "카메라가 클리핑하는 지점에서 headroom+2.47스톱 아래"이고, 촬영
노출이 정확했다면 그게 곧 기준 그레이다. 어긋나면 `--exposure`로 밀거나 엔진의 노출
슬라이더로 상쇄한다 — 조건 (a)는 노출 시프트와 대수적으로 같아서 완전히 상쇄된다.

사용법:
    pip install rawpy numpy tifffile
    python tools/decode-raw.py in.ARW out.tiff [-h 5] [--exposure 0]
    python tools/decode-raw.py --selftest
"""
import argparse
import sys

WORKING_GAMMA = 1.8
ANCHOR = 0.18


def encode_prophoto(lin):
    """선형 → ProPhoto(ROMM) γ1.8 인코딩. 발끝 직선부까지 규격대로."""
    import numpy as np

    out = np.where(lin < 0.001953125, lin * 16.0, np.power(np.clip(lin, 0, None), 1.0 / WORKING_GAMMA))
    return np.clip(out, 0.0, 1.0)


# ROMM(ProPhoto) 원색 — D50 PCS 기준 열이 곧 rXYZ·gXYZ·bXYZ다
PROPHOTO_TO_XYZ_D50 = [
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0, 0.0, 0.8252100],
]
D50 = (0.9642, 1.0, 0.8249)


def prophoto_icc():
    """
    ProPhoto RGB ICC v2 디스플레이 프로파일 바이트(행렬 + 감마 1.8).

    ── 왜 박나 (2026-10-07) ─────────────────────────────────────────────────
    예전엔 안 박고 "Photoshop에서 프로파일 지정 → ProPhoto RGB"를 안내했다. 그걸
    빼먹으면 Photoshop이 작업 색공간(sRGB 등)으로 읽어, ProPhoto 값이 sRGB로
    해석된 채 내보내져 **채도가 크게 빠져 보였다** — 실사용에서 실제로 밟아 "리니어
    경로가 채도가 낮다"는 오판으로 이어졌다(N6 확인 중). 박으면 이 함정이 사라진다.

    TRC는 Adobe `ProPhoto RGB` 프로파일과 같은 `curv` 감마 하나(u8Fixed8 0x01CD =
    1.8008)다 — 사용자가 손으로 하던 "프로파일 지정"과 똑같아지는 것이 목적이다.
    ⚠️ 인코딩(`encode_prophoto`)의 발끝 직선부(선형 < 1/512)는 표현하지 않는다 —
    8bit 0~1 구간이라 차이가 안 보이고, Adobe 프로파일도 그렇다.
    """
    import struct

    s15 = lambda x: struct.pack(">i", int(round(x * 65536)))
    xyz = lambda v: b"XYZ " + b"\0" * 4 + b"".join(s15(c) for c in v)
    curv = b"curv" + b"\0" * 4 + struct.pack(">IH", 1, 0x01CD) + b"\0\0"
    name = b"ProPhoto RGB (FilmSim decode-raw)"
    desc = (b"desc" + b"\0" * 4 + struct.pack(">I", len(name) + 1) + name + b"\0"
            + struct.pack(">II", 0, 0) + struct.pack(">HB", 0, 0) + b"\0" * 67)
    cprt = b"text" + b"\0" * 4 + b"No copyright, use freely\0"
    cols = [[row[i] for row in PROPHOTO_TO_XYZ_D50] for i in range(3)]
    tags = [(b"desc", desc), (b"cprt", cprt), (b"wtpt", xyz(D50)),
            (b"rXYZ", xyz(cols[0])), (b"gXYZ", xyz(cols[1])), (b"bXYZ", xyz(cols[2])),
            (b"rTRC", curv), (b"gTRC", curv), (b"bTRC", curv)]
    off = 128 + 4 + 12 * len(tags)
    table, data = b"", b""
    for sig, body in tags:
        body += b"\0" * (-len(body) % 4)  # 태그는 4바이트 경계
        table += sig + struct.pack(">II", off + len(data), len(body))
        data += body
    size = off + len(data)
    header = (struct.pack(">I", size) + b"\0" * 4 + struct.pack(">I", 0x02100000)
              + b"mntrRGB XYZ " + b"\0" * 12 + b"acsp" + b"\0" * 24
              + struct.pack(">I", 0) + b"".join(s15(c) for c in D50) + b"\0" * 48)
    assert len(header) == 128
    return header + struct.pack(">I", len(tags)) + table + data


def write_tiff(path, arr16):
    """
    16bit RGB TIFF로 쓴다. `tifffile`에 맡긴다. ProPhoto ICC를 박는다(`prophoto_icc`).

    ⚠️ **직접 쓰지 않는다.** 한 번 손으로 IFD를 조립해 봤는데, PIL이 열기는 하면서
    픽셀은 8비트로 잘라 읽었다 — 파일이 틀렸는지 리더가 부족한지 **구분할 방법이
    없었다.** 그 상태로 넘기면 Photoshop에서야 드러난다. 포맷은 검증된 라이브러리에
    맡기고, 이 도구는 **값이 맞는지**에만 책임진다.
    """
    import tifffile

    tifffile.imwrite(path, arr16, photometric="rgb", iccprofile=prophoto_icc())


def probe_patch(lin, spec):
    """`x,y[,size]`로 지정한 정사각 패치의 평균 선형값(3채널 평균)."""
    import numpy as np

    parts = [int(v) for v in spec.split(",")]
    if len(parts) not in (2, 3):
        raise SystemExit("--probe는 x,y 또는 x,y,size 형식입니다")
    x, y = parts[0], parts[1]
    n = parts[2] if len(parts) == 3 else 64
    h, w, _ = lin.shape
    x0, y0 = max(0, x - n // 2), max(0, y - n // 2)
    x1, y1 = min(w, x0 + n), min(h, y0 + n)
    if x1 <= x0 or y1 <= y0:
        raise SystemExit(f"--probe 좌표가 이미지({w}x{h}) 밖입니다")
    patch = lin[y0:y1, x0:x1, :]
    return float(patch.mean()), (x0, y0, x1 - x0, y1 - y0)


def load_linear(raw_path):
    """RAW → 화이트 레벨 기준 선형 ProPhoto(0~1, HxWx3 float64).

    `decode()`와 `decode-raw-gui.py`가 **이 함수 하나**를 공유한다 — postprocess
    인자를 두 곳에 따로 두면 GUI 미리보기와 실제 내보내기가 조용히 다른 수를
    낼 수 있다(`core/color/inputs.js`를 나눈 것과 같은 이유).
    """
    import numpy as np
    import rawpy

    with rawpy.imread(raw_path) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=True,      # 자동 밝기 = 씬마다 다른 톤. 절대 켜지 않는다
            gamma=(1, 1),             # **선형** — 이 도구의 존재 이유
            output_color=rawpy.ColorSpace.ProPhoto,
            output_bps=16,
            user_flip=0,
        )
    return rgb.astype(np.float64) / 65535.0


def decode(raw_path, out_path, headroom, exposure, midgray, probe):
    import numpy as np

    lin = load_linear(raw_path)
    h, w, _ = lin.shape
    target = 2.0 ** -headroom          # 기준 그레이가 가야 할 선형값
    notes = []

    # ── 기준 그레이를 어디에 놓을 것인가 ────────────────────────────────
    #
    # libraw의 1.0은 **화이트 레벨**(센서 포화)이지 "씬의 18% 그레이"가 아니다.
    # 그래서 이 도구는 기준 그레이가 어디 있는지 **모른다** — 알려주지 않으면
    # 스케일을 걸 수 없다. 조용히 추정해 넣으면 그게 곧 검증 안 된 앵커가 된다.
    if probe:
        measured, box = probe_patch(lin, probe)
        notes.append(f"패치 {box[0]},{box[1]} {box[2]}x{box[3]} 평균 선형 {measured:.6f}")
    else:
        measured = midgray

    if measured:
        if measured <= 0:
            raise SystemExit("기준 그레이 선형값이 0 이하입니다")
        scale = target / measured
        lin *= scale
        notes.append(f"스케일 ×{scale:.4f} ({np.log2(scale):+.2f}스톱) → 기준 그레이를 {target:.6f}에 놓음")
    else:
        notes.append(
            "⚠️ 기준 그레이 위치를 모릅니다 — **스케일을 걸지 않았습니다.** "
            "화이트 레벨 기준 선형 그대로입니다."
        )
        notes.append(
            "   `--probe x,y[,size]`로 그레이 패치를 찍거나 `--midgray <선형값>`을 주십시오. "
            "없이 쓰면 엔진 노출 슬라이더로 눈으로 맞춰야 합니다(조건 (a)는 그것으로 상쇄됩니다)."
        )

    lin *= 2.0 ** exposure
    if exposure:
        notes.append(f"추가 노출 {exposure:+.2f}스톱")

    clipped = float((lin >= 1.0).mean()) * 100.0
    enc = encode_prophoto(lin)
    arr16 = np.clip(np.rint(enc * 65535.0), 0, 65535).astype(np.uint16)
    write_tiff(out_path, arr16)

    mid_enc = target ** (1 / WORKING_GAMMA)
    sys.stderr.write(
        f"{out_path}: {w}x{h} 16bit 선형 ProPhoto\n"
        + "".join(f"  {n}\n" for n in notes)
        + f"  잘린 화소 {clipped:.3f}%\n"
        f"  → ProPhoto RGB ICC 포함 — Photoshop에서 프로파일 지정 불필요\n"
        f"  → 엔진 패널의 입력 소스를 **「리니어 +{headroom}스톱」**\n"
        f"     (그 설정의 기준 그레이 = 인코딩 {mid_enc:.4f} / 8bit {round(mid_enc * 255)})\n"
    )


def selftest():
    """
    ⚠️ 이 도구가 지켜야 할 성질을 **raw 없이** 검산한다.

    (b) 선형성 — 합성 램프를 넣고 `log2(v^1.8)`가 스톱당 정확히 1.0씩 움직이는가.
    그리고 엔진의 `linear-h{N}` 전달함수와 **왕복이 맞는가** — 여기서 놓은 자리와
    저기서 읽는 자리가 어긋나면 통째로 노출이 밀린다.
    """
    import numpy as np

    ok = True
    lin = np.array([ANCHOR * 2.0 ** s for s in range(-5, 3)])
    v = encode_prophoto(lin)
    steps = np.diff(np.log2(np.power(v, WORKING_GAMMA)))
    worst = float(np.max(np.abs(steps - 1.0)))
    print(f"  {'OK  ' if worst < 1e-12 else '❌  '}인코딩이 순수 거듭제곱  스톱 간격 최대편차 {worst:.1e}")
    ok = ok and worst < 1e-12

    # 엔진 쪽 정의와 대조. inputs.js의 decode(v) = v^1.8 · 0.18 · 2^N 이므로
    # 기준 그레이(선형 2^-N)를 인코딩한 값을 넣으면 정확히 0.18이 나와야 한다.
    for n in (4, 5, 6):
        code = float(encode_prophoto(np.array([2.0 ** -n]))[0])
        back = code ** WORKING_GAMMA * ANCHOR * 2.0 ** n
        good = abs(back - ANCHOR) < 1e-12
        ok = ok and good
        print(f"  {'OK  ' if good else '❌  '}헤드룸 +{n}스톱 왕복  "
              f"기준 그레이 인코딩 {code:.4f} → 엔진이 읽는 선형 {back:.9f}")

    # ICC — 파일에 실제로 실리는가, 그리고 색 관리 엔진(littlecms)이 ProPhoto로 읽는가.
    # 원색 정의가 틀리면 Photoshop에서야 드러나므로 여기서 sRGB 변환을 독립 계산과 대조한다.
    import io
    import os
    import tempfile

    import tifffile

    icc = prophoto_icc()
    path = os.path.join(tempfile.mkdtemp(), "icc.tif")
    write_tiff(path, np.zeros((2, 2, 3), np.uint16))
    with tifffile.TiffFile(path) as t:
        back = bytes(t.pages[0].tags["InterColorProfile"].value)
    good = back == icc
    ok = ok and good
    print(f"  {'OK  ' if good else '❌  '}TIFF에 ProPhoto ICC가 실린다  {len(icc)}바이트")
    try:
        from PIL import Image, ImageCms
    except ImportError:
        print("      (ICC 색 변환 검사 건너뜀 — Pillow 없음)")
    else:
        xf = ImageCms.buildTransform(ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                     ImageCms.createProfile("sRGB"), "RGB", "RGB")
        probe = [(200, 80, 60), (60, 160, 90), (70, 90, 200), (128, 128, 128)]
        src = Image.new("RGB", (len(probe), 1))
        src.putdata(probe)
        got = np.array(ImageCms.applyTransform(src, xf), float)[0]
        # 독립 계산: γ1.8 → ROMM → XYZ(D50) → Bradford D65 → sRGB
        brad = np.linalg.inv(np.array([[1.0478112, 0.0228866, -0.0501270],
                                       [0.0295424, 0.9904844, -0.0170491],
                                       [-0.0092345, 0.0150436, 0.7521316]]))
        to_s = np.linalg.inv(np.array([[0.4124564, 0.3575761, 0.1804375],
                                       [0.2126729, 0.7151522, 0.0721750],
                                       [0.0193339, 0.1191920, 0.9503041]]))
        m = to_s @ brad @ np.array(PROPHOTO_TO_XYZ_D50)
        lin = np.clip((np.array(probe, float) / 255) ** 1.8 @ m.T, 0, 1)
        want = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055) * 255
        worst = float(np.abs(got - want).max())
        good = worst <= 3
        ok = ok and good
        print(f"  {'OK  ' if good else '❌  '}littlecms가 ICC를 ProPhoto로 읽는다  sRGB 변환 최대차 {worst:.1f}/255")

    print("\n✅ 전 항목 통과" if ok else "\n❌ 실패 항목 있음")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 add_help=False)
    ap.add_argument("--help", action="help")
    ap.add_argument("--selftest", action="store_true", help="raw 없이 성질 검산")
    ap.add_argument("raw_path", nargs="?", help="입력 RAW")
    ap.add_argument("out_path", nargs="?", help="출력 16bit TIFF")
    ap.add_argument("-h", "--headroom", type=int, default=5, choices=(4, 5, 6),
                    help="기준 그레이 위로 담을 스톱 수 (기본 5)")
    ap.add_argument("--midgray", type=float, default=None,
                    help="화이트 레벨 기준 선형 이미지에서 18%% 그레이가 있는 값(0~1). "
                         "주면 그것을 헤드룸 자리에 정확히 놓는다")
    ap.add_argument("--probe", default=None, metavar="X,Y[,SIZE]",
                    help="--midgray를 이미지에서 직접 잰다. 그레이 카드 중심 좌표")
    ap.add_argument("--exposure", type=float, default=0.0,
                    help="추가 배율을 스톱으로. 스케일을 건 뒤에 더 밀 때")
    a = ap.parse_args()

    if a.selftest:
        sys.exit(selftest())
    if not a.raw_path or not a.out_path:
        ap.error("raw_path와 out_path가 필요합니다 (또는 --selftest)")
    decode(a.raw_path, a.out_path, a.headroom, a.exposure, a.midgray, a.probe)


if __name__ == "__main__":
    main()
