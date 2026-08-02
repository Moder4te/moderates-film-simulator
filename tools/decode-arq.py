#!/usr/bin/env python3
"""RAW(ARQ 등 픽셀시프트 포함) 파일을 16비트 PPM으로 푼다.

tools/measure-scan.js가 읽는 입력을 만드는 앞단이다. rawpy(libraw)가 없으면
이 저장소의 다른 JS 코드는 전혀 건드리지 않는다 — RAW 디코딩만 파이썬에 맡기고
측정 자체는 의존성 없는 JS로 한다(tools/extract_tds_curves.py와 같은 분리).

Sony ARQ(픽셀시프트 스택)는 raw_type이 Stack이라 filters=0 — 이미 화소마다
실측 RGB가 있어 디모자이크가 필요 없다. demosaic_algorithm을 뭘 줘도 결과가
바이트 단위로 동일함을 확인했다(2026-08-02, AHD vs LINEAR diff std=0).
"""
import argparse
import sys

import rawpy


def decode(raw_path, out_ppm):
    with rawpy.imread(raw_path) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=True,
            output_bps=16,
            half_size=False,
        )
    h, w, _ = rgb.shape
    with open(out_ppm, "wb") as f:
        f.write(f"P6\n{w} {h}\n65535\n".encode("ascii"))
        # PPM 16비트는 빅엔디안이 규격이다.
        f.write(rgb.astype(">u2").tobytes())
    print(f"{out_ppm}: {w}x{h}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("raw_path", help="입력 RAW 파일 (.ARQ/.ARW 등 rawpy가 여는 모든 형식)")
    ap.add_argument("out_ppm", help="출력 16비트 PPM 경로")
    decode(**vars(ap.parse_args()))


if __name__ == "__main__":
    main()
