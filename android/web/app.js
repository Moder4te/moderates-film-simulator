/**
 * 안드로이드 엔진 앱 화면.
 *
 * 하는 일은 Photoshop 엔진 패널의 [적용]과 같다 — 사진 한 장에 필름 LUT을 건다.
 * 레이어·문서가 없으니 원본은 늘 메모리에 그대로 있고, 결과는 새 파일로만 저장한다.
 * **원본 파일을 덮어쓰는 길이 없다.**
 *
 * 색 계산은 전부 worker.js(엔진)에서 한다. 여기는 입출력과 화면뿐이다.
 *
 * 안드로이드 쪽 다리(`window.FilmSimAndroid`)가 없으면 일반 브라우저로 보고
 * 저장을 다운로드로 대신한다 — 데스크톱에서 화면을 시험할 수 있게.
 */

(function () {
  "use strict";

  /** 미리보기 긴 변(px). 슬라이더를 움직일 때마다 이 크기로 다시 계산한다. */
  const PREVIEW_EDGE = 1600;
  /**
   * 저장 해상도 상한(화소 수). WebView 캔버스는 기기마다 한계가 달라 그보다 큰
   * 사진은 비율을 지켜 줄인다. 줄였으면 상태줄에 알린다.
   */
  const MAX_PIXELS = 40e6;
  const LUT_PREVIEW = 33;
  const LUT_PRECISE = 65;
  const JPEG_QUALITY = 0.95;

  const $ = (id) => document.getElementById(id);
  const ui = {
    open: $("open"),
    file: $("file"),
    view: $("view"),
    empty: $("empty"),
    badge: $("badge"),
    film: $("film"),
    exposure: $("exposure"),
    exposureOut: $("exposureOut"),
    paper: $("paper"),
    scanner: $("scanner"),
    dodgeBurn: $("dodgeBurn"),
    precise: $("precise"),
    note: $("note"),
    status: $("status"),
    save: $("save"),
  };
  const bridge = window.FilmSimAndroid || null;

  // ── 워커 ────────────────────────────────────────────────────────────────

  const worker = new Worker("worker.js");
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data);
    else p.reject(new Error(e.data.error));
  };
  function call(msg, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  // ── 상태 ────────────────────────────────────────────────────────────────

  let catalog = null;
  let source = null; // { name, full: ImageData, preview: ImageData, scaled: bool }
  let result = null; // 미리보기 결과 ImageData
  let showingOriginal = false;
  let rendering = false;
  let dirty = false;
  let saving = false;

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function currentParams() {
    const p = JSON.parse(JSON.stringify(catalog.defaults));
    p.name = "Android";
    p.film.id = ui.film.value;
    p.film.exposure = Number(ui.exposure.value);
    p.film.paper = ui.paper.value;
    p.film.scanner = ui.scanner.value;
    p.film.dodgeBurn.enabled = ui.dodgeBurn.checked;
    return p;
  }

  function fillSelect(sel, items, label, value) {
    sel.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.id;
      o.textContent = label(it);
      sel.appendChild(o);
    }
    sel.value = value;
  }

  function syncExposureRange() {
    const f = catalog.films.find((x) => x.id === ui.film.value);
    const [lo, hi] = (f && f.exposureRange) || [-2, 2];
    ui.exposure.min = lo;
    ui.exposure.max = hi;
    const v = Math.min(hi, Math.max(lo, Number(ui.exposure.value)));
    ui.exposure.value = v;
    ui.exposureOut.textContent = (v > 0 ? "+" : "") + v.toFixed(1);
  }

  function updateNote() {
    const pp = catalog.papers.find((x) => x.id === ui.paper.value);
    const sc = catalog.scanners.find((x) => x.id === ui.scanner.value);
    ui.note.textContent = [pp && pp.note, sc && sc.id !== "none" && sc.note].filter(Boolean).join(" · ");
  }

  // ── 그리기 ──────────────────────────────────────────────────────────────

  function draw() {
    const img = showingOriginal || !result ? source && source.preview : result;
    if (!img) return;
    const ctx = ui.view.getContext("2d");
    if (ui.view.width !== img.width || ui.view.height !== img.height) {
      ui.view.width = img.width;
      ui.view.height = img.height;
    }
    ctx.putImageData(img, 0, 0);
    ui.badge.hidden = !showingOriginal;
  }

  function copyImageData(img) {
    return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }

  /** 대상 버퍼를 워커에 넘겨 색을 입힌다. 넘긴 버퍼는 사본이다 — 원본은 안 건드린다. */
  async function renderImage(img, size) {
    const copy = new Uint8ClampedArray(img.data);
    const r = await call(
      { type: "render", params: currentParams(), size, buffer: copy.buffer },
      [copy.buffer]
    );
    return { image: new ImageData(new Uint8ClampedArray(r.buffer), img.width, img.height), ms: r.ms };
  }

  /** 미리보기 갱신. 계산 중에 또 바뀌면 끝난 뒤 한 번만 더 돈다(코얼레싱). */
  async function refresh() {
    if (!source) return;
    if (rendering) {
      dirty = true;
      return;
    }
    rendering = true;
    try {
      do {
        dirty = false;
        const r = await renderImage(source.preview, LUT_PREVIEW);
        result = r.image;
        draw();
        setStatus(`${source.name} · ${source.full.width}×${source.full.height} · ${r.ms}ms`);
      } while (dirty);
    } catch (err) {
      setStatus("오류: " + err.message);
    } finally {
      rendering = false;
    }
  }

  // ── 열기 ────────────────────────────────────────────────────────────────

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function readPixels(bitmap, w, h) {
    const c = canvasOf(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  async function openBlob(blob, name) {
    setStatus("여는 중…");
    // EXIF 방향은 createImageBitmap이 반영한다(imageOrientation 기본값 from-image).
    const bmp = await createImageBitmap(blob);
    let w = bmp.width;
    let h = bmp.height;
    let scaled = false;
    if (w * h > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / (w * h));
      w = Math.floor(w * k);
      h = Math.floor(h * k);
      scaled = true;
    }
    const full = readPixels(bmp, w, h);
    const pk = Math.min(1, PREVIEW_EDGE / Math.max(w, h));
    const preview = pk < 1 ? readPixels(bmp, Math.round(w * pk), Math.round(h * pk)) : copyImageData(full);
    bmp.close && bmp.close();

    source = { name: name || "photo", full, preview, scaled };
    result = null;
    ui.view.hidden = false;
    ui.empty.hidden = true;
    ui.save.disabled = false;
    draw();
    await refresh();
    if (scaled) setStatus(`${ui.status.textContent} · 큰 사진이라 ${w}×${h}로 줄여 처리`);
  }

  ui.open.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", () => {
    const f = ui.file.files && ui.file.files[0];
    ui.file.value = "";
    if (f) openBlob(f, f.name).catch((err) => setStatus("열기 실패: " + err.message));
  });

  /** 다른 앱에서 "공유"로 넘겨받은 사진. 안드로이드 쪽이 /shared/image로 내준다. */
  async function openShared() {
    if (!bridge || !bridge.hasSharedImage()) return;
    const res = await fetch("/shared/image?t=" + Date.now());
    if (!res.ok) throw new Error("공유 사진을 못 읽었다 (" + res.status + ")");
    await openBlob(await res.blob(), bridge.sharedImageName() || "shared");
  }
  window.filmSimOpenShared = () => openShared().catch((err) => setStatus("열기 실패: " + err.message));

  // ── 원본 비교 (누르고 있는 동안) ────────────────────────────────────────

  function hold(on) {
    if (!source || showingOriginal === on) return;
    showingOriginal = on;
    draw();
  }
  const stage = $("stage");
  stage.addEventListener("pointerdown", () => hold(true));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) stage.addEventListener(ev, () => hold(false));

  // ── 저장 ────────────────────────────────────────────────────────────────

  function baseName(name) {
    return String(name).replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_") || "photo";
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  ui.save.addEventListener("click", async () => {
    if (!source || saving) return;
    saving = true;
    ui.save.disabled = true;
    try {
      setStatus("원본 해상도로 계산 중…");
      const size = ui.precise.checked ? LUT_PRECISE : LUT_PREVIEW;
      const r = await renderImage(source.full, size);
      const c = canvasOf(r.image.width, r.image.height);
      c.getContext("2d").putImageData(r.image, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", JPEG_QUALITY));
      if (!blob) throw new Error("JPEG 인코딩 실패");

      const name = `${baseName(source.name)}_${ui.film.value}.jpg`;
      if (bridge) {
        const answer = bridge.saveJpeg(await blobToBase64(blob), name);
        if (!answer.startsWith("ok:")) throw new Error(answer.replace(/^error:/, ""));
        setStatus("저장됨: " + answer.slice(3));
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        setStatus("다운로드: " + name);
      }
    } catch (err) {
      setStatus("저장 실패: " + err.message);
    } finally {
      saving = false;
      ui.save.disabled = !source;
    }
  });

  // ── 시작 ────────────────────────────────────────────────────────────────

  call({ type: "catalog" })
    .then((r) => {
      catalog = r.catalog;
      const d = catalog.defaults.film;
      fillSelect(ui.film, catalog.films, (f) => `${f.name} (ISO ${f.iso})`, d.id);
      fillSelect(ui.paper, catalog.papers, (x) => x.name, d.paper);
      fillSelect(ui.scanner, catalog.scanners, (x) => x.name, d.scanner);
      ui.exposure.value = d.exposure;
      ui.dodgeBurn.checked = !!(d.dodgeBurn && d.dodgeBurn.enabled);
      syncExposureRange();
      updateNote();

      ui.film.addEventListener("change", () => {
        syncExposureRange();
        refresh();
      });
      ui.exposure.addEventListener("input", () => {
        syncExposureRange();
        refresh();
      });
      for (const el of [ui.paper, ui.scanner]) {
        el.addEventListener("change", () => {
          updateNote();
          refresh();
        });
      }
      ui.dodgeBurn.addEventListener("change", refresh);

      setStatus("준비");
      window.filmSimOpenShared();
    })
    .catch((err) => setStatus("엔진 로드 실패: " + err.message));
})();
