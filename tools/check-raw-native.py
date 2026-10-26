#!/usr/bin/env python3
"""안드로이드 앱의 네이티브 RAW 현상이 `decode-raw.py`와 **같은 수를 내는가.**

폰 앱(`android/app/src/main/cpp/filmsim_raw.cpp`)은 decode-raw.py의 `load_linear` +
`encode_prophoto`를 C++로 옮긴 것이다. 옮기면서 인자 하나만 어긋나도(화이트밸런스,
감마, 출력 색공간) 결과는 그럴듯하게 나와서 눈으로는 못 잡는다. 그래서 같은 RAW를
두 길로 풀어 화소 단위로 대조한다.

  1. 현상  — 호스트용 `filmsim-raw-cli` 출력 vs `decode-raw.py` 경로(rawpy)
  2. LUT   — C++ 사면체 보간 vs 엔진 `core/color/lut.js` `sample`(노드)

준비:
    pip install rawpy numpy
    cmake -S android/app/src/main/cpp -B build/raw-native && cmake --build build/raw-native -j
    python tools/check-raw-native.py build/raw-native/filmsim-raw-cli some.NEF [more.CR2 ...]

⚠️ rawpy에 든 LibRaw와 앱의 LibRaw 버전이 다르면 디모자이크 세부가 달라 작은 차이가
날 수 있다. 판정 기준은 그것을 감안한 값이다(아래 TOL_*).
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

# 16bit 코드 기준. 같은 LibRaw면 0이어야 하고, 버전이 달라도 몇 코드 안쪽이다.
TOL_MEAN = 2.0
TOL_P999 = 64


def reference(raw_path):
    """decode-raw.py와 같은 경로: load_linear → encode_prophoto → 16bit 반올림."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("decode_raw", os.path.join(ROOT, "tools", "decode-raw.py"))
    dr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dr)
    lin = dr.load_linear(raw_path)
    return np.clip(np.rint(dr.encode_prophoto(lin) * 65535.0), 0, 65535).astype(np.uint16)


def check_decode(cli, raw_path, tmp):
    out = os.path.join(tmp, "out.rgb16")
    try:
        want = reference(raw_path)
    except Exception as e:  # rawpy가 못 여는 파일은 대조할 기준이 없다
        print(f"  ⚠️  {os.path.basename(raw_path)}  기준(rawpy)이 열지 못함 — 건너뜀 ({e})")
        return True
    info = json.loads(subprocess.check_output([cli, raw_path, out]))
    got = np.fromfile(out, dtype="<u2").reshape(info["height"], info["width"], 3)
    if got.shape != want.shape:
        print(f"  ❌  {os.path.basename(raw_path)}  크기 다름 {got.shape} vs {want.shape}")
        return False
    diff = np.abs(got.astype(np.int32) - want.astype(np.int32))
    mean, p999, mx = float(diff.mean()), float(np.percentile(diff, 99.9)), int(diff.max())
    ok = mean <= TOL_MEAN and p999 <= TOL_P999
    print(f"  {'OK  ' if ok else '❌  '}{os.path.basename(raw_path)}  {info['width']}x{info['height']} "
          f"{info['make']} {info['model']}  평균차 {mean:.3f} · 99.9% {p999:.0f} · 최대 {mx} (16bit)")
    return ok


def check_lut(cli, tmp):
    """엔진이 구운 LUT을 C++와 JS로 각각 걸어 비교한다. 입력은 무작위 16bit 화소."""
    size = 33
    rng = np.random.default_rng(7)
    src = rng.integers(0, 65536, size=(20000, 3), dtype=np.uint16)
    src_path = os.path.join(tmp, "src.rgb16")
    lut_path = os.path.join(tmp, "lut.f32")
    js_path = os.path.join(tmp, "js.rgba")
    src.astype("<u2").tofile(src_path)

    script = f"""
const fs = require("fs");
const film = require({json.dumps(os.path.join(ROOT, "core/color/film"))});
const lut = require({json.dumps(os.path.join(ROOT, "core/color/lut"))});
const {{ defaultParams }} = require({json.dumps(os.path.join(ROOT, "apps/engine/src/params"))});
const p = defaultParams();
p.film.input = "linear-h5";
p.film.paper = "kodak-endura-premier";
const t = film.buildForParams(p, {size});
fs.writeFileSync({json.dumps(lut_path)}, Buffer.from(t.buffer));
const src = new Uint16Array(fs.readFileSync({json.dumps(src_path)}).buffer.slice(0));
const out = Buffer.alloc(src.length / 3 * 4);
const o = [0, 0, 0];
for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {{
  lut.sample(t, {size}, src[i] / 65535, src[i + 1] / 65535, src[i + 2] / 65535, o);
  for (let c = 0; c < 3; c++) out[j + c] = Math.min(255, Math.max(0, Math.round(o[c] * 255)));
  out[j + 3] = 255;
}}
fs.writeFileSync({json.dumps(js_path)}, out);
"""
    subprocess.check_call(["node", "-e", script])
    cpp_path = os.path.join(tmp, "cpp.rgba")
    subprocess.check_call([cli, "--lut", lut_path, str(size), src_path, cpp_path])
    a = np.fromfile(cpp_path, dtype=np.uint8).astype(int)
    b = np.fromfile(js_path, dtype=np.uint8).astype(int)
    mx = int(np.abs(a - b).max())
    off = float((a != b).mean()) * 100
    ok = mx <= 1
    print(f"  {'OK  ' if ok else '❌  '}LUT 적용 C++ = JS(core/color/lut.js)  최대차 {mx}/255 · 다른 값 {off:.3f}%")
    return ok


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cli, raws = sys.argv[1], sys.argv[2:]
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        print("── LUT 적용 ──")
        ok = check_lut(cli, tmp) and ok
        if raws:
            print("── 현상 (vs decode-raw.py) ──")
        for r in raws:
            ok = check_decode(cli, r, tmp) and ok
    print("\n✅ 전 항목 통과" if ok else "\n❌ 실패 항목 있음")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
