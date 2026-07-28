/**
 * 커스텀 슬라이더 (div + PointerEvent).
 *
 * UXP의 sp-slider는 native 호스트 컨트롤로 매핑되어 드래그 중 input 처리가 느리다
 * (측정: 초당 ~11 input, 프레임 간격 중앙값 124ms). 순수 HTML input[type=range]는
 * UXP가 렌더하지 않는다(0×0). 그래서 div와 PointerEvent로 직접 만든다.
 *
 * 마크업(각 슬라이더):
 *   <div class="cs" data-id=".." data-min=".." data-max=".." data-step=".." data-value="..">
 *     <div class="cs-label">라벨</div>
 *     <div class="cs-track"><div class="cs-fill"></div><div class="cs-thumb"></div></div>
 *     <div class="cs-val"></div>
 *   </div>
 */

function fmt(value, step) {
  return step < 1 ? value.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(value));
}

function quantize(value, min, max, step) {
  let v = Math.max(min, Math.min(max, value));
  v = Math.round((v - min) / step) * step + min;
  return Math.round(v * 1000) / 1000;
}

/** 하나의 .cs 요소를 슬라이더로 초기화한다. 컨트롤러 객체를 반환한다. */
function init(el) {
  const min = parseFloat(el.dataset.min);
  const max = parseFloat(el.dataset.max);
  const step = parseFloat(el.dataset.step) || 1;
  const track = el.querySelector(".cs-track");
  const fill = el.querySelector(".cs-fill");
  const thumb = el.querySelector(".cs-thumb");
  const valEl = el.querySelector(".cs-val");

  let value = quantize(parseFloat(el.dataset.value) || 0, min, max, step);
  const defaultValue = value; // data-value 초기값. 더블탭 리셋 대상.
  const listeners = [];

  function render() {
    const pct = max === min ? 0 : (value - min) / (max - min);
    const p = (pct * 100).toFixed(2) + "%";
    fill.style.width = p;
    thumb.style.left = p;
    if (valEl) valEl.textContent = fmt(value, step);
  }

  function setValue(v, notify) {
    const q = quantize(v, min, max, step);
    if (q === value && notify !== "force") {
      if (notify) return; // 값 동일 + 알림 요청 → 중복 통지 안 함
    }
    value = q;
    render();
    if (notify) for (const fn of listeners) fn(value);
  }

  // 드래그 상태. 트랙 위치는 드래그 중 변하지 않으므로 pointerdown에서 한 번만
  // 측정해 캐시한다. 매 pointermove마다 getBoundingClientRect를 부르면 강제 동기
  // 레이아웃(reflow)이 일어나 드래그가 버벅인다.
  let dragRect = null;
  let pendingX = null;
  let dragRAF = false;
  let moveHandler = null;
  let upHandler = null;

  function applyClientX(clientX) {
    if (!dragRect) return;
    const pct = dragRect.width
      ? Math.max(0, Math.min(1, (clientX - dragRect.left) / dragRect.width))
      : 0;
    setValue(min + pct * (max - min), true);
  }

  // pointermove는 좌표만 저장하고, rAF로 프레임당 한 번만 실제 반영한다.
  // 연속 move를 코얼레싱해 native 리페인트 폭주(블랙아웃)를 막는다.
  function flushDrag() {
    dragRAF = false;
    if (pendingX !== null) {
      applyClientX(pendingX);
      pendingX = null;
    }
  }

  let lastTap = 0;
  track.addEventListener("pointerdown", (e) => {
    const now = performance.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      setValue(defaultValue, true); // 더블탭 → 기본값 리셋
      return;
    }
    lastTap = now;

    dragRect = track.getBoundingClientRect();
    applyClientX(e.clientX);
    moveHandler = (ev) => {
      pendingX = ev.clientX;
      if (!dragRAF) {
        dragRAF = true;
        requestAnimationFrame(flushDrag);
      }
    };
    upHandler = () => {
      document.removeEventListener("pointermove", moveHandler);
      document.removeEventListener("pointerup", upHandler);
      document.removeEventListener("pointercancel", upHandler);
      moveHandler = null;
      upHandler = null;
      dragRect = null;
      pendingX = null;
    };
    document.addEventListener("pointermove", moveHandler);
    document.addEventListener("pointerup", upHandler);
    document.addEventListener("pointercancel", upHandler);
  });

  render();

  return {
    id: el.dataset.id,
    getValue: () => value,
    setValue: (v) => setValue(v, false), // 프로그램적 설정(통지 안 함)
    onChange: (fn) => listeners.push(fn),
  };
}

/** root 안의 모든 .cs 를 초기화해 { id: controller } 맵을 반환한다. */
function initAll(root) {
  const map = {};
  const nodes = (root || document).querySelectorAll(".cs");
  for (const el of nodes) {
    const ctrl = init(el);
    map[ctrl.id] = ctrl;
  }
  return map;
}

module.exports = { init, initAll };
