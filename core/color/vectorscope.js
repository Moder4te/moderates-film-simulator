/**
 * 벡터스코프 — 색상·채도 평면의 **분포 밀도**를 격자로 센다.
 *
 * ── 왜 격자인가 ─────────────────────────────────────────────────────────
 *
 * UXP에서는 canvas가 드래그 중 검게 클리어되고 SVG·rotate도 못 쓴다. 쓸 수 있는 것은
 * **DOM + translate뿐**이다(UXP-NOTES 5). 그래서 픽셀마다 점을 찍는 방식은 불가능하다 —
 * 수만 개의 div를 만들 수 없다.
 *
 * 대신 평면을 격자로 나눠 **도수를 세고, 비어 있지 않은 칸만** 그린다. 실사진에서
 * 분포는 한쪽에 몰리므로 실제로 그려지는 칸은 보통 수백 개다.
 *
 * ── 좌표 ────────────────────────────────────────────────────────────────
 *
 * 각도 규약은 **컬러휠과 같다**(`gamut.polarOffset`). 같은 화면에 놓이는데 각도가
 * 다르면 두 그림을 함께 읽을 수 없다. 방송 벡터스코프의 YUV 평면과는 각도가 다르다 —
 * 이 도구는 계측기가 아니라 사진가용이라 컬러휠과의 일관성을 택했다.
 *
 * 반경은 채도, 각도는 색상각. 무채색은 중심에 모인다.
 *
 * ── 한계 (표시할 것) ────────────────────────────────────────────────────
 *
 * 방송용 계측이 아니라 **분포의 모양을 보는 용도**다. 격자 해상도만큼 뭉개지고,
 * 프록시에서 세므로 소수 픽셀의 극단값은 사라진다.
 *
 * 순수 계산이다. DOM은 호출자가 그린다.
 */

/**
 * 밀도 정규화 기준 분위. 최대값이 아니라 이 분위를 1.0으로 놓는다(아래 cells 주석).
 */
const NORM_PCT = 0.95;

/**
 * 격자 누적기. 셀 좌표는 [-1,1] 정규화 평면을 n등분한 것이다.
 *
 * @param {number} n 한 변의 칸 수 (64 권장)
 */
function createGrid(n) {
  const size = n || 64;
  const counts = new Uint32Array(size * size);
  let total = 0;
  let peak = 0;

  return {
    size,

    /**
     * 색 하나를 센다. r,g,b는 0~1.
     *
     * ── 반경은 **크로마**(max−min)다. HSV 채도가 아니다 ──────────────────
     *
     * 처음엔 HSV 채도(=(max−min)/max)를 반경으로 썼는데, 그 값은 **밝기로 나눈 값**
     * 이라 어두운 색이 과대평가된다. 필름룩은 암부를 눌러 min이 0에 붙는 픽셀을 많이
     * 만드는데, 그러면 실제로는 진하지 않은 그림자까지 채도 1.0으로 튀어 **원 가장자리에
     * 박힌다.** 링이 통째로 차 보이던 원인이다(실측: 필름룩에서 p50 0.62 · 바깥 20%에 14%).
     *
     * 크로마는 밝기에 비례하므로 어두운 색은 중심 근처에 남는다(같은 조건 p50 0.33 ·
     * 바깥 20%에 0%). 실제 벡터스코프가 쓰는 양이기도 하다.
     *
     * 색상각은 그대로 HSV 기준이다(컬러휠과 각도를 맞춘다).
     *
     * 무채색은 세지 않는다 — 중심에 쌓이는데 실사진은 무채가 압도적이라 중심만 탄다.
     */
    add(r, g, b) {
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = mx - mn;
      if (mx <= 0 || d <= 0) return; // 완전 무채 — 중심에 쌓이므로 버린다
      const sat = d > 1 ? 1 : d; // 크로마. 0~1이라 그대로 반경이 된다

      let h;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;

      // 컬러휠과 같은 배치: x = cos, y = -sin (화면 y축이 아래로 증가)
      const rad = (h * Math.PI) / 180;
      const x = Math.cos(rad) * sat;
      const y = -Math.sin(rad) * sat;

      // [-1,1] → [0,size)
      let cx = ((x + 1) / 2) * size;
      let cy = ((y + 1) / 2) * size;
      cx = cx < 0 ? 0 : cx >= size ? size - 1 : cx | 0;
      cy = cy < 0 ? 0 : cy >= size ? size - 1 : cy | 0;

      const i = cy * size + cx;
      const c = ++counts[i];
      if (c > peak) peak = c;
      total++;
    },

    /**
     * 비어 있지 않은 칸만 돌려준다. 호출자는 이것만 DOM으로 그린다.
     *
     * ── 정규화를 두 번 고쳤다 ───────────────────────────────────────────
     *
     * 처음엔 **로그**를 썼다. "소수 픽셀도 보이게" 하려던 것인데, 실사진에서는
     * 도수가 대체로 같은 자릿수라(평균 77 · 최대 214) 로그가 전 구간을 0.65~1.0으로
     * **압축해 모든 칸이 똑같이 진해졌다** — 원이 통째로 채워져 보인다.
     *
     * 그렇다고 **최대값 기준 선형**도 안 된다. 하늘처럼 한 색이 압도하는 사진에서는
     * 그 칸이 peak를 20000까지 끌어올려 나머지가 0.003으로 사라진다.
     *
     * 그래서 **상위 분위(p95)를 기준**으로 잡고 그 위는 1.0으로 클램프한다.
     * 분포가 평탄하면 p95가 최대값에 가까워 선형처럼 동작하고, 한 칸이 압도하면
     * 그 칸만 클램프되고 나머지가 살아난다.
     *
     * @returns {{cells: Array<{x:number,y:number,d:number}>, total:number, peak:number}}
     *   x,y는 0~1 정규화 위치(칸 중심), d는 0~1 밀도
     */
    cells() {
      const out = [];
      if (peak <= 0) return { cells: out, total, peak };

      const nz = [];
      for (let i = 0; i < counts.length; i++) if (counts[i] > 0) nz.push(counts[i]);
      nz.sort((a, b) => a - b);
      const ref = Math.max(1, nz[Math.min(nz.length - 1, Math.floor(nz.length * NORM_PCT))]);

      for (let i = 0; i < counts.length; i++) {
        const c = counts[i];
        if (c === 0) continue;
        const d = c / ref;
        out.push({
          x: ((i % size) + 0.5) / size,
          y: ((i / size) | 0) / size + 0.5 / size,
          d: d > 1 ? 1 : d,
        });
      }
      return { cells: out, total, peak };
    },
  };
}

module.exports = { createGrid };
