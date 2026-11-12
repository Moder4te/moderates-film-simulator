#!/usr/bin/env python3
"""RAW 플랫 현상(WebAssembly)이 tools/decode-raw.py(rawpy)와 **화소 단위로** 같은가.

    pip install rawpy numpy
    python tools/check-raw.py sample.NEF [more.ARW ...]

Studio가 여는 RAW는 `apps/studio/vendor/filmsim-raw.wasm`(LibRaw)이 푼다. 공식 경로는
`decode-raw.py`다. 둘이 같은 LibRaw 판·같은 인자라고 **적혀** 있는 것과 실제로 같은 수를
내는 것은 다른 얘기다 — 빌드 옵션 하나(스레드·SIMD·데모자이크 선택)로도 값이 갈린다.

노드로 WASM을 돌려 선형 16bit를 받고, rawpy의 같은 인자 결과와 전 화소를 비교한다.
절반 크기 현상도 같이 본다(rawpy `half_size=True`).
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NODE = r"""
const fs = require("fs"), path = require("path");
// `node -e`에는 스크립트 이름 칸이 없다 — 인자가 argv[1]부터다
const root = process.argv[1], file = process.argv[2], half = process.argv[3] === "1", out = process.argv[4];
const { createRawDecoder } = require(path.join(root, "core/io/rawdecoder"));
const dec = createRawDecoder(fs.readFileSync(path.join(root, "apps/studio/vendor/filmsim-raw.wasm")));
const t = Date.now();
const r = dec.decode(new Uint8Array(fs.readFileSync(file)), { half, flip: false, linear: true });
fs.writeFileSync(out, Buffer.from(r.data.buffer));
console.log(JSON.stringify({ width: r.width, height: r.height, make: r.make, model: r.model, dng: r.dng,
  baselineExposure: r.baselineExposure, version: dec.version(), ms: Date.now() - t }));
"""


def main():
    import numpy as np
    import rawpy

    files = sys.argv[1:]
    if not files:
        raise SystemExit(__doc__)
    fails = 0
    for path in files:
        for half in (False, True):
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "wasm.bin")
                r = subprocess.run(["node", "-e", NODE, ROOT, path, "1" if half else "0", out],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"FAIL  {os.path.basename(path)} — WASM 현상 실패\n{r.stderr.strip()}")
                    fails += 1
                    continue
                info = json.loads(r.stdout.strip().splitlines()[-1])
                wasm = np.fromfile(out, dtype=np.uint16).reshape(info["height"], info["width"], 3)
            with rawpy.imread(path) as raw:
                # decode-raw.py `load_linear`와 같은 인자
                ref = raw.postprocess(use_camera_wb=True, no_auto_bright=True, gamma=(1, 1),
                                      output_color=rawpy.ColorSpace.ProPhoto, output_bps=16,
                                      user_flip=0, half_size=half)
            same_shape = wasm.shape == ref.shape
            diff = int(np.abs(wasm.astype(np.int32) - ref.astype(np.int32)).max()) if same_shape else -1
            ok = same_shape and diff == 0
            fails += 0 if ok else 1
            lib = ".".join(str(v) for v in rawpy.libraw_version)
            print(f"{'  OK ' if ok else 'FAIL '} {os.path.basename(path)} {'절반' if half else '원본'} "
                  f"{info['width']}×{info['height']} {info['make']} {info['model']} — "
                  f"rawpy(LibRaw {lib}) 대비 최대차 {diff}/65535 · WASM {info['version']} {info['ms']}ms")
    print("\nRAW 현상 검사 " + ("실패" if fails else "통과 — WASM이 decode-raw.py와 화소 단위로 같다"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
