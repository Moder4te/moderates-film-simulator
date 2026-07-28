/**
 * 3D LUT — 생성·조회·적용.
 *
 * 격자 저장 순서는 .cube 규약을 따른다: R 인덱스가 가장 빨리 변한다.
 *   idx(r, g, b) = ((b * N + g) * N + r) * 3
 * 이렇게 두면 .cube 파일을 파싱/직렬화할 때 재배열이 필요 없다.
 *
 * 보간은 사면체(tetrahedral)를 쓴다. 삼선형은 격자를 정육면체 단위로 다루기 때문에
 * 감산 혼합처럼 채널이 함께 급격히 꺾이는 구간에서 등고선(banding)이 보인다.
 * 사면체는 정육면체를 6개의 사면체로 나눠 3개 축 성분의 크기 순서에 따라 실제로
 * 지나가는 경로만 보간하므로 그 문제가 없다.
 *
 * v2에서 이 보간이 최종 이미지에 직접 적용된다. Color Lookup 조정 레이어 방식이었다면
 * 적용 시점의 보간은 Photoshop이 담당해 제어할 수 없었다.
 */

/**
 * ⚠️ Photoshop의 16bit는 **0~32768**이다. 0~65535가 아니다.
 *
 * 내부적으로 15비트+1을 쓰기 때문이고, `imaging.getPixels`도 이 범위로 준다.
 * `putPixels`에 32768을 넘는 값을 주면
 *   "invalid pixel data - 16 bit value is outside the photoshop range"
 * 로 거부한다.
 *
 * 8bit(0~255)에서 유추해 65535를 쓰기 쉬운데, 그러면 입력은 실제보다 어둡게
 * 해석되고 출력은 범위를 넘는다. 채널을 자리바꿈만 하는 LUT(예: R↔B 스왑)은
 * 출력이 입력 범위를 넘지 않아 **이 오류가 드러나지 않는다** — de-risk 검증이
 * 스왑 LUT을 썼던 탓에 이 버그를 통과시켰다.
 */
const PS_MAX_16 = 32768;

/** 소스 버퍼의 심도에 맞는 최대값. */
function maxValueFor(data) {
  return data.BYTES_PER_ELEMENT === 2 ? PS_MAX_16 : 255;
}

/** 항등 LUT. size³ 격자, 채널당 0~1 float. */
function identity(size) {
  const lut = new Float32Array(size * size * size * 3);
  const d = size - 1;
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lut[p++] = r / d;
        lut[p++] = g / d;
        lut[p++] = b / d;
      }
    }
  }
  return lut;
}

/** R↔B를 맞바꾸는 LUT. 적용 여부를 눈으로 즉시 판별할 수 있어 검증에 쓴다. */
function swapRB(size) {
  const lut = new Float32Array(size * size * size * 3);
  const d = size - 1;
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lut[p++] = b / d;
        lut[p++] = g / d;
        lut[p++] = r / d;
      }
    }
  }
  return lut;
}

/**
 * 사면체 보간 조회. 입력 r/g/b는 0~1, 출력은 out[0..2]에 0~1로 쓴다.
 *
 * 정육면체 안에서 fr/fg/fb의 대소 관계가 어느 사면체에 속하는지를 결정하고,
 * 그 사면체의 네 꼭짓점만으로 보간한다. 분기 6갈래가 그 6개 사면체다.
 */
function sample(lut, size, r, g, b, out) {
  const d = size - 1;
  const x = r * d;
  const y = g * d;
  const z = b * d;

  let i = x | 0;
  let j = y | 0;
  let k = z | 0;
  if (i >= d) i = d - 1;
  if (j >= d) j = d - 1;
  if (k >= d) k = d - 1;
  if (i < 0) i = 0;
  if (j < 0) j = 0;
  if (k < 0) k = 0;

  const fr = x - i;
  const fg = y - j;
  const fb = z - k;

  const s1 = 3;
  const s2 = size * 3;
  const s3 = size * size * 3;
  const o = (k * size * size + j * size + i) * 3;

  // 꼭짓점 오프셋. c[abc]에서 a=r, b=g, c=b 방향으로 +1.
  const c000 = o;
  const c100 = o + s1;
  const c010 = o + s2;
  const c001 = o + s3;
  const c110 = o + s1 + s2;
  const c101 = o + s1 + s3;
  const c011 = o + s2 + s3;
  const c111 = o + s1 + s2 + s3;

  let p0, p1, p2, p3;
  let w1, w2, w3;

  if (fr > fg) {
    if (fg > fb) {
      // fr > fg > fb
      p0 = c000; p1 = c100; p2 = c110; p3 = c111;
      w1 = fr; w2 = fg; w3 = fb;
      for (let c = 0; c < 3; c++) {
        out[c] = lut[p0 + c]
          + (lut[p1 + c] - lut[p0 + c]) * w1
          + (lut[p2 + c] - lut[p1 + c]) * w2
          + (lut[p3 + c] - lut[p2 + c]) * w3;
      }
      return;
    }
    if (fr > fb) {
      // fr > fb > fg
      for (let c = 0; c < 3; c++) {
        out[c] = lut[c000 + c]
          + (lut[c100 + c] - lut[c000 + c]) * fr
          + (lut[c111 + c] - lut[c101 + c]) * fg
          + (lut[c101 + c] - lut[c100 + c]) * fb;
      }
      return;
    }
    // fb > fr > fg
    for (let c = 0; c < 3; c++) {
      out[c] = lut[c000 + c]
        + (lut[c101 + c] - lut[c001 + c]) * fr
        + (lut[c111 + c] - lut[c101 + c]) * fg
        + (lut[c001 + c] - lut[c000 + c]) * fb;
    }
    return;
  }

  if (fb > fg) {
    // fb > fg > fr
    for (let c = 0; c < 3; c++) {
      out[c] = lut[c000 + c]
        + (lut[c111 + c] - lut[c011 + c]) * fr
        + (lut[c011 + c] - lut[c001 + c]) * fg
        + (lut[c001 + c] - lut[c000 + c]) * fb;
    }
    return;
  }
  if (fb > fr) {
    // fg > fb > fr
    for (let c = 0; c < 3; c++) {
      out[c] = lut[c000 + c]
        + (lut[c111 + c] - lut[c011 + c]) * fr
        + (lut[c010 + c] - lut[c000 + c]) * fg
        + (lut[c011 + c] - lut[c010 + c]) * fb;
    }
    return;
  }
  // fg > fr > fb
  for (let c = 0; c < 3; c++) {
    out[c] = lut[c000 + c]
      + (lut[c110 + c] - lut[c010 + c]) * fr
      + (lut[c010 + c] - lut[c000 + c]) * fg
      + (lut[c111 + c] - lut[c110 + c]) * fb;
  }
}

/**
 * 픽셀 버퍼 전체에 LUT을 적용해 RGB 3채널 버퍼를 만든다.
 *
 * imaging.getPixels가 주는 chunky 버퍼를 그대로 받는다. 채널 수(comps)는 문서마다
 * 다르다 — 투명도/레이어가 있으면 4(RGBA), 플랫하면 3. 알파는 버린다
 * (encodeImageData가 알파 있는 버퍼를 JPEG로 못 만들고, LUT은 색만 다룬다).
 *
 * 입출력 심도는 소스와 같게 유지한다. 16bit 문서에서 8bit로 떨구면 v2가 16bit를
 * 전제한 의미가 없어진다.
 */
function applyToBuffer(data, comps, pixelCount, lut, size) {
  const is16 = data.BYTES_PER_ELEMENT === 2;
  const maxV = maxValueFor(data); // 16bit는 32768. 위 PS_MAX_16 주석 참조.
  const out = is16 ? new Uint16Array(pixelCount * 3) : new Uint8Array(pixelCount * 3);
  const inv = 1 / maxV;
  const tmp = [0, 0, 0];

  const count = Math.min(pixelCount, Math.floor(data.length / comps));
  const gOff = comps > 1 ? 1 : 0;
  const bOff = comps > 2 ? 2 : 0;

  for (let p = 0, i = 0, j = 0; p < count; p++, i += comps, j += 3) {
    sample(lut, size, data[i] * inv, data[i + gOff] * inv, data[i + bOff] * inv, tmp);
    let r = tmp[0] * maxV;
    let g = tmp[1] * maxV;
    let b = tmp[2] * maxV;
    // ⚠️ **반올림한다.** 정수 타입 배열에 float을 대입하면 0 쪽으로 **버려진다.**
    // 채널마다 평균 −0.5LSB 편향이고, 이 경로만 그랬다 — `core/optics/tone.js`는
    // 이미 같은 자리에서 `(q+0.5)|0`으로 반올림한다. 즉 **네 산출 경로 중
    // putPixels만 다르게 양자화**하고 있었고, 정합성 검사의 putPixels 최대차가
    // 그 차이를 포함하고 있었다.
    // 클램프가 음수를 먼저 걷어내므로 양수 구간이고, 거기서 `(v+0.5)|0`은
    // Math.round와 같고 훨씬 싸다(tone.js와 같은 규약).
    out[j] = r < 0 ? 0 : r > maxV ? maxV : (r + 0.5) | 0;
    out[j + 1] = g < 0 ? 0 : g > maxV ? maxV : (g + 0.5) | 0;
    out[j + 2] = b < 0 ? 0 : b > maxV ? maxV : (b + 0.5) | 0;
  }
  return out;
}

/** .cube 텍스트로 직렬화. 색공간은 호출자가 주석으로 넘긴다. */
function toCube(lut, size, title, colorSpaceNote) {
  const lines = [
    `TITLE "${title}"`,
    `# Color space: ${colorSpaceNote}`,
    "# Generated by FilmSim",
    `LUT_3D_SIZE ${size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
    "",
  ];
  const n = size * size * size;
  for (let p = 0; p < n; p++) {
    const o = p * 3;
    lines.push(
      `${lut[o].toFixed(6)} ${lut[o + 1].toFixed(6)} ${lut[o + 2].toFixed(6)}`
    );
  }
  return lines.join("\n") + "\n";
}

module.exports = { identity, swapRB, sample, applyToBuffer, toCube, maxValueFor, PS_MAX_16 };
