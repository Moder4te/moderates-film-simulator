/**
 * 컬러휠 색 이동 시각화 (DOM, translate 전용).
 *
 * UXP 렌더링 제약으로 최종적으로 translate만 쓴다:
 *   - canvas: 드래그 리페인트 때 검게 클리어됨(블랙아웃) → DOM으로.
 *   - CSS rotate: 시각적으로 적용되지 않음(bbox 불변 확인) → 회전 요소 불가.
 *   - CSS translate: 정상 → 모든 요소를 중심 기준 translate로 배치한다.
 *
 * 구성 (전부 translate 배치):
 *   - 색상환: 원주에 색점 72개(정적). 링을 이룬다.
 *   - 눈금: 동심원 2개(정적, border-radius).
 *   - 마커: 색마다 원본(○)·적용(●) 점.
 *   - 이동 경로: 원본→적용 사이에 작은 점 3개를 찍어 점선 화살표를 대신한다.
 *
 * 좌표계: 각도=색조(0°=우측, 반시계), 반경=채도. 중심 기준 translate 오프셋.
 */

const simulate = require("./simulate");

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

function hslToRgb(h, s, l) {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** 색조·채도 → 중심 기준 [dx, dy] px 오프셋. */
function polarOffset(h, s, radius) {
  const rad = (h * Math.PI) / 180;
  return [Math.cos(rad) * s * radius, -Math.sin(rad) * s * radius];
}

function hsvToRgb(h, s, v) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function makeEl(cls, style) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (style) Object.assign(d.style, style);
  return d;
}

const SIZE = 240;
const PAD = 10;
const TRAIL = 3; // 원본→적용 사이 경로 점 개수

/** 중심(50%,50%)에 놓이고 translate로 이동하는 점 요소를 만든다. */
function makeDot(size, style) {
  return makeEl("cw-dot", Object.assign({
    position: "absolute",
    left: "50%",
    top: "50%",
    width: size + "px",
    height: size + "px",
    marginLeft: -(size / 2) + "px",
    marginTop: -(size / 2) + "px",
    borderRadius: "50%",
  }, style || {}));
}

function build(container, options) {
  container.innerHTML = "";
  const onMarkerDrag = options && options.onMarkerDrag;
  const onMarkerReset = options && options.onMarkerReset;
  const ringR = SIZE / 2 - PAD; // 색상환 반경 (110)
  const markerR = ringR - 20; // 마커 최대 반경 (90), 링 안쪽

  // 적용점(●) 마커를 드래그하면 포인터 위치를 색조/채도로 환산해 콜백한다.
  // 트랙(컨테이너) 중심은 드래그 중 안 변하므로 pointerdown에서 1회 캐시하고,
  // pointermove는 좌표만 저장해 rAF로 프레임당 1회만 콜백한다(성능).
  let dragIndex = -1;
  let dragCenter = null;
  let pendingXY = null;
  let dragRAF = false;

  function emitDrag() {
    dragRAF = false;
    if (dragIndex < 0 || !pendingXY || !onMarkerDrag) return;
    const dx = pendingXY[0] - dragCenter[0];
    const dy = pendingXY[1] - dragCenter[1];
    let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    // 가장자리(markerR)에서 1.0. 휠 밖으로 더 끌면 1을 넘겨 강도를 키운다
    // (핸들러가 이 값으로 CMY 조절 강도를 증폭한다). 상한 2.5로 제한.
    const sat = Math.max(0, Math.min(2.5, Math.hypot(dx, dy) / markerR));
    onMarkerDrag(dragIndex, hue, sat);
  }

  function startMarkerDrag(index, e) {
    const r = container.getBoundingClientRect();
    dragCenter = [r.left + r.width / 2, r.top + r.height / 2];
    dragIndex = index;
    pendingXY = [e.clientX, e.clientY];
    emitDrag();
    const move = (ev) => {
      pendingXY = [ev.clientX, ev.clientY];
      if (!dragRAF) {
        dragRAF = true;
        requestAnimationFrame(emitDrag);
      }
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      dragIndex = -1;
      dragCenter = null;
      pendingXY = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  }

  // 색상환: 원주 색점 (정적). rotate가 안 되므로 각 hue 위치에 translate로 찍는다.
  const NUM = 72;
  for (let i = 0; i < NUM; i++) {
    const hue = i * (360 / NUM);
    const [x, y] = polarOffset(hue, 1, ringR);
    const [r, g, b] = hslToRgb(hue, 0.85, 0.55);
    const dot = makeDot(7, { background: `rgb(${r},${g},${b})` });
    dot.style.transform = `translate(${x}px,${y}px)`;
    container.appendChild(dot);
  }

  // 눈금 동심원 (정적)
  for (const s of [0.5, 1]) {
    const d = markerR * 2 * s;
    container.appendChild(
      makeEl("cw-grid", {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: d + "px",
        height: d + "px",
        marginLeft: -(d / 2) + "px",
        marginTop: -(d / 2) + "px",
        borderRadius: "50%",
        border: "1px solid rgba(150,150,150,0.16)",
      })
    );
  }

  // 동적 풀: 색마다 원본·적용 점 + 경로 점 TRAIL개.
  const origDots = [];
  const gradeDots = [];
  const trails = []; // trails[i] = [dot, dot, dot]

  function ensure(n) {
    while (origDots.length < n) {
      const trail = [];
      for (let k = 0; k < TRAIL; k++) {
        const t = makeDot(3, { background: "rgba(255,255,255,0.55)" });
        container.appendChild(t);
        trail.push(t);
      }
      const orig = makeDot(7, { boxShadow: "0 0 0 1px rgba(255,255,255,0.55)" });
      const grade = makeDot(13, {
        boxShadow: "0 0 0 1.5px rgba(0,0,0,0.55)",
        cursor: "grab",
      });
      // 적용점 드래그 → 색역 자동 선택 + CMY 조절. 더블탭(300ms 내 재탭)은 리셋.
      const idx = origDots.length;
      let lastTap = 0;
      grade.addEventListener("pointerdown", (e) => {
        const now = performance.now();
        if (now - lastTap < 300) {
          lastTap = 0;
          if (onMarkerReset) onMarkerReset(idx);
          return;
        }
        lastTap = now;
        startMarkerDrag(idx, e);
      });
      container.appendChild(orig);
      container.appendChild(grade);
      trails.push(trail);
      origDots.push(orig);
      gradeDots.push(grade);
    }
  }

  function place(dot, x, y) {
    dot.style.transform = `translate(${x}px,${y}px)`;
  }

  function update(palette, grading) {
    ensure(palette.length);
    for (let i = 0; i < palette.length; i++) {
      const rgb = palette[i];
      const after = simulate.applyGrading(rgb, grading);
      const b = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      const a = rgbToHsv(after[0], after[1], after[2]);
      const [ox, oy] = polarOffset(b.h, b.s, markerR);
      const [gx, gy] = polarOffset(a.h, a.s, markerR);

      origDots[i].style.background = `rgb(${rgb.join(",")})`;
      place(origDots[i], ox, oy);
      gradeDots[i].style.background = `rgb(${after.map(Math.round).join(",")})`;
      place(gradeDots[i], gx, gy);

      const moved = Math.hypot(gx - ox, gy - oy) > 3;
      for (let k = 0; k < TRAIL; k++) {
        const t = trails[i][k];
        if (moved) {
          const f = (k + 1) / (TRAIL + 1);
          place(t, ox + (gx - ox) * f, oy + (gy - oy) * f);
          t.style.opacity = "1";
        } else {
          t.style.opacity = "0";
        }
      }
    }
    for (let i = palette.length; i < origDots.length; i++) {
      place(origDots[i], -9999, 0);
      place(gradeDots[i], -9999, 0);
      for (const t of trails[i]) t.style.opacity = "0";
    }
  }

  return { update };
}

/**
 * 무채색(whites/neutrals/blacks) 전용 미니 컬러휠. 중심에서 드래그하면 그 톤에
 * 부여할 색조/채도를 콜백한다. 큰 휠에서는 무채색이 중심에 뭉쳐 못 고르므로 분리.
 * opts: { onDrag(hue, sat) }
 */
function buildMini(container, opts) {
  container.innerHTML = "";
  const size = 76;
  const R = size / 2 - 5;
  const markerR = R - 5;

  const NUM = 24;
  for (let i = 0; i < NUM; i++) {
    const hue = i * (360 / NUM);
    const [x, y] = polarOffset(hue, 1, R);
    const [r, g, b] = hslToRgb(hue, 0.8, 0.55);
    const dot = makeDot(4, { background: `rgb(${r},${g},${b})` });
    dot.style.transform = `translate(${x}px,${y}px)`;
    container.appendChild(dot);
  }

  const innerD = markerR * 2 - 4;
  container.appendChild(
    makeEl("cw-inner", {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: innerD + "px",
      height: innerD + "px",
      marginLeft: -(innerD / 2) + "px",
      marginTop: -(innerD / 2) + "px",
      borderRadius: "50%",
      background: "rgba(22,22,24,0.9)",
    })
  );

  const marker = makeDot(10, {
    background: "#ccc",
    boxShadow: "0 0 0 1.5px rgba(0,0,0,0.55)",
    cursor: "grab",
  });
  container.appendChild(marker);

  let center = null;
  let pending = null;
  let raf = false;

  function emit() {
    raf = false;
    if (!pending || !center) return;
    const dx = pending[0] - center[0];
    const dy = pending[1] - center[1];
    let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const sat = Math.max(0, Math.min(1, Math.hypot(dx, dy) / markerR));
    const [mx, my] = polarOffset(hue, sat, markerR);
    marker.style.transform = `translate(${mx}px,${my}px)`;
    if (opts && opts.onDrag) opts.onDrag(hue, sat);
  }

  let lastTap = 0;
  container.addEventListener("pointerdown", (e) => {
    const now = performance.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      marker.style.transform = "translate(0px,0px)"; // 중심 복귀
      if (opts && opts.onReset) opts.onReset();
      return;
    }
    lastTap = now;

    const r = container.getBoundingClientRect();
    center = [r.left + r.width / 2, r.top + r.height / 2];
    pending = [e.clientX, e.clientY];
    emit();
    const move = (ev) => {
      pending = [ev.clientX, ev.clientY];
      if (!raf) {
        raf = true;
        requestAnimationFrame(emit);
      }
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      center = null;
      pending = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });

  return {
    setMarker(hue, sat) {
      const [mx, my] = polarOffset(hue, sat, markerR);
      marker.style.transform = `translate(${mx}px,${my}px)`;
    },
  };
}

module.exports = { build, buildMini, rgbToHsv, hsvToRgb, hslToRgb, polarOffset, SIZE };
