/**
 * 안드로이드 엔진 앱 화면.
 *
 * 하는 일은 Photoshop 엔진 패널의 [적용]과 같다 — 사진 한 장에 필름 LUT을 건다.
 * 레이어·문서가 없으니 원본은 늘 메모리에 그대로 있고, 결과는 새 파일로만 저장한다.
 * **원본 파일을 덮어쓰는 길이 없다.**
 *
 * 소스는 두 종류다.
 *   srgb8  JPEG·PNG·HEIC 등 — WebView가 풀고, 저장도 여기서 한다
 *   raw16  RAW(DNG·ARW·CR3·NEF …) — 안드로이드 쪽이 LibRaw로 톤 커브 없이 현상해
 *          들고 있다. 여기는 줄인 미리보기만 받고, 원본 해상도 적용·저장은 엔진이
 *          구운 LUT을 넘겨 네이티브가 한다(큰 버퍼가 WebView를 거치지 않게).
 *
 * 색 계산(LUT 굽기)은 전부 worker.js(엔진)에서 한다. 여기는 입출력과 화면뿐이다.
 *
 * 안드로이드 쪽 다리(`window.FilmSimAndroid`)가 없으면 일반 브라우저로 보고
 * 저장을 다운로드로 대신한다 — 데스크톱에서 화면을 시험할 수 있게(RAW는 안 된다).
 */

(function () {
  "use strict";

  /** 미리보기 긴 변(px). 슬라이더를 움직일 때마다 이 크기로 다시 계산한다. */
  const PREVIEW_EDGE = 1600;
  /**
   * 저장 해상도 상한(화소 수). WebView 캔버스는 기기마다 한계가 달라 그보다 큰
   * 사진은 비율을 지켜 줄인다. 줄였으면 상태줄에 알린다. RAW에는 해당 없다(네이티브).
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
    headroomRow: $("headroomRow"),
    headroom: $("headroom"),
    dodgeBurn: $("dodgeBurn"),
    precise: $("precise"),
    rawHalfRow: $("rawHalfRow"),
    rawHalf: $("rawHalf"),
    warning: $("warning"),
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
  /**
   * srgb8: { kind, name, full: ImageData, preview: ImageData, scaled }
   * raw16: { kind, name, info, preview16: Uint16Array, width, height, original: {key, image} }
   */
  let source = null;
  let result = null; // 미리보기 결과 ImageData
  let showingOriginal = false;
  let rendering = false;
  let dirty = false;
  let saving = false;

  function setStatus(text) {
    ui.status.textContent = text;
  }

  const isRaw = () => !!source && source.kind === "raw16";

  function currentParams() {
    const p = JSON.parse(JSON.stringify(catalog.defaults));
    p.name = "Android";
    p.film.id = ui.film.value;
    p.film.exposure = Number(ui.exposure.value);
    p.film.paper = ui.paper.value;
    p.film.scanner = ui.scanner.value;
    p.film.dodgeBurn.enabled = ui.dodgeBurn.checked;
    // RAW는 앱이 톤 커브 없이 현상한 것이라 「리니어 +N스톱」으로 읽는다. 그 밖은 sRGB를
    // ProPhoto로 옮겨 넣으므로 기본 입력 그대로다(worker.js 머리말).
    p.film.input = isRaw() ? `linear-h${ui.headroom.value}` : "prophoto";
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

  function exposureRange() {
    const f = catalog.films.find((x) => x.id === ui.film.value);
    return (f && f.exposureRange) || [-2, 2];
  }

  function syncExposureRange() {
    const [lo, hi] = exposureRange();
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

  /** 입력 × 인화지 조합 경고(core/color/inputs.js combinationWarning). RAW에서만 뜬다. */
  async function updateWarning() {
    const r = await call({ type: "warning", params: currentParams() });
    ui.warning.textContent = r.warning ? "⚠️ " + r.warning.replace(/\*\*/g, "") : "";
    ui.warning.hidden = !r.warning;
  }

  function describeSource() {
    if (!source) return "";
    if (isRaw()) {
      const i = source.info;
      const cam = [i.make, i.model].filter(Boolean).join(" ");
      return `${source.name} · RAW ${i.width}×${i.height}${cam ? " · " + cam : ""}`;
    }
    return `${source.name} · ${source.full.width}×${source.full.height}`;
  }

  // ── 그리기 ──────────────────────────────────────────────────────────────

  function draw() {
    let img = result;
    if (showingOriginal || !result) img = isRaw() ? source.original.image : source && source.preview;
    if (!img) return;
    const ctx = ui.view.getContext("2d");
    if (ui.view.width !== img.width || ui.view.height !== img.height) {
      ui.view.width = img.width;
      ui.view.height = img.height;
    }
    ctx.putImageData(img, 0, 0);
    ui.badge.textContent = isRaw() ? "원본 (선형, 톤 커브 없음)" : "원본";
    ui.badge.hidden = !showingOriginal;
  }

  function copyImageData(img) {
    return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }

  /** 대상 버퍼를 워커에 넘겨 색을 입힌다. 넘긴 버퍼는 사본이다 — 원본은 안 건드린다. */
  async function renderImage(img, size) {
    const copy = new Uint8ClampedArray(img.data);
    const r = await call(
      { type: "render", source: "srgb8", params: currentParams(), size, buffer: copy.buffer },
      [copy.buffer]
    );
    return { image: new ImageData(new Uint8ClampedArray(r.buffer), img.width, img.height), ms: r.ms };
  }

  async function renderRawPreview(original) {
    const copy = new Uint16Array(source.preview16);
    const r = await call(
      { type: "render", source: "raw16", original, params: currentParams(), size: LUT_PREVIEW, buffer: copy.buffer },
      [copy.buffer]
    );
    return { image: new ImageData(new Uint8ClampedArray(r.buffer), source.width, source.height), ms: r.ms };
  }

  /** RAW 원본 보기 — 헤드룸이 바뀌면 다시 만든다(그레이를 놓는 자리가 바뀌므로). */
  async function ensureRawOriginal() {
    const key = ui.headroom.value;
    if (source.original.key === key) return;
    const r = await renderRawPreview(true);
    source.original = { key, image: r.image };
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
        const r = isRaw() ? await renderRawPreview(false) : await renderImage(source.preview, LUT_PREVIEW);
        result = r.image;
        if (isRaw()) await ensureRawOriginal();
        draw();
        await updateWarning();
        setStatus(`${describeSource()} · ${r.ms}ms`);
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

  function showSource() {
    result = null;
    showingOriginal = false;
    ui.view.hidden = false;
    ui.empty.hidden = true;
    ui.save.disabled = false;
    ui.headroomRow.hidden = !isRaw();
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

    source = { kind: "srgb8", name: name || "photo", full, preview, scaled };
    showSource();
    draw();
    await refresh();
    if (scaled) setStatus(`${ui.status.textContent} · 큰 사진이라 ${w}×${h}로 줄여 처리`);
  }

  /**
   * 네이티브가 현상해 둔 RAW를 받는다.
   *
   * 리니어 입력에는 **실측 곡선 인화지**가 필요하다 — 어깨 없는 인화지는 +4~6스톱을
   * 못 눌러 채널마다 다른 자리가 잘린다(inputs.js combinationWarning). 그래서 지금
   * 인화지가 곡선이 없으면 곡선 있는 것으로 바꾸고 알린다.
   *
   * DNG의 BaselineExposure(폰 RAW에 흔하다 — 일부러 어둡게 기록하고 "이만큼 올려
   * 보라"고 적어 둔다)는 노광 슬라이더의 시작값으로 옮긴다. 현상 값 자체는
   * decode-raw.py와 같게 두고, 올리는 것은 엔진 노광으로 한다(조건 (a)는 노광과
   * 대수적으로 같다 — docs/ARCHITECTURE.md).
   */
  async function openRaw(name) {
    const info = JSON.parse(bridge.rawInfo());
    const res = await fetch("/raw/preview?t=" + Date.now());
    if (!res.ok) throw new Error("RAW 미리보기를 못 받았다 (" + res.status + ")");
    const preview16 = new Uint16Array(await res.arrayBuffer());
    if (preview16.length !== info.previewWidth * info.previewHeight * 3) throw new Error("RAW 미리보기 크기가 맞지 않는다");

    source = {
      kind: "raw16",
      name: name || "raw",
      info,
      preview16,
      width: info.previewWidth,
      height: info.previewHeight,
      original: { key: null, image: null },
    };
    showSource();

    const notes = [];
    const cur = catalog.papers.find((x) => x.id === ui.paper.value);
    if (!cur || !cur.hasCurves) {
      const curved = catalog.papers.find((x) => x.hasCurves);
      if (curved) {
        ui.paper.value = curved.id;
        updateNote();
        notes.push(`인화지를 ${curved.name}(실측 곡선)으로 바꿈`);
      }
    }
    const [lo, hi] = exposureRange();
    const be = Math.round((info.baselineExposure || 0) * 10) / 10;
    ui.exposure.value = Math.min(hi, Math.max(lo, be));
    syncExposureRange();
    if (be) notes.push(`DNG 기준 노출 ${be > 0 ? "+" : ""}${be.toFixed(1)}스톱을 노광 시작값으로`);

    await refresh();
    const extra = [];
    if (info.clippedPercent > 0.5) extra.push(`센서 포화 ${info.clippedPercent.toFixed(1)}%`);
    if (notes.length || extra.length) setStatus(`${ui.status.textContent} · ${notes.concat(extra).join(" · ")}`);
  }

  ui.open.addEventListener("click", () => {
    // 안드로이드에서는 네이티브 선택기로 고른다 — RAW는 WebView가 못 풀어서
    // 파일을 안드로이드 쪽이 받아야 한다. 고른 뒤 filmSimOpenShared가 불린다.
    if (bridge) bridge.pickPhoto();
    else ui.file.click();
  });
  ui.file.addEventListener("change", () => {
    const f = ui.file.files && ui.file.files[0];
    ui.file.value = "";
    if (f) openBlob(f, f.name).catch((err) => setStatus("열기 실패: " + err.message));
  });

  /** 안드로이드 쪽이 고르거나 "공유"로 넘겨받은 사진을 연다. */
  async function openShared() {
    if (!bridge || !catalog) return;
    const kind = bridge.sourceKind();
    const name = bridge.sharedImageName() || "photo";
    if (kind === "raw") return openRaw(name);
    if (kind !== "image") return;
    const res = await fetch("/shared/image?t=" + Date.now());
    if (!res.ok) throw new Error("사진을 못 읽었다 (" + res.status + ")");
    await openBlob(await res.blob(), name);
  }
  window.filmSimOpenShared = () => openShared().catch((err) => setStatus("열기 실패: " + err.message));
  /** RAW 현상은 수 초 걸린다. 안드로이드 쪽이 진행 상황을 여기로 알린다. */
  window.filmSimStatus = (text) => setStatus(text);

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

  function bytesToBase64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** 네이티브 저장은 비동기다 — 끝나면 filmSimSaveDone으로 결과가 돌아온다. */
  let saveDone = null;
  window.filmSimSaveDone = (answer) => {
    if (saveDone) saveDone(answer);
    saveDone = null;
  };

  async function saveRaw(size, name) {
    setStatus("원본 해상도에 LUT 적용 중…");
    const r = await call({ type: "lut", source: "raw16", params: currentParams(), size });
    const b64 = bytesToBase64(new Uint8Array(r.table));
    const answer = await new Promise((resolve) => {
      saveDone = resolve;
      bridge.saveRaw(b64, size, name);
    });
    if (!answer.startsWith("ok:")) throw new Error(answer.replace(/^error:/, ""));
    return answer.slice(3);
  }

  async function saveSrgb(size, name) {
    setStatus("원본 해상도로 계산 중…");
    const r = await renderImage(source.full, size);
    const c = canvasOf(r.image.width, r.image.height);
    c.getContext("2d").putImageData(r.image, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("JPEG 인코딩 실패");
    if (bridge) {
      const answer = bridge.saveJpeg(await blobToBase64(blob), name);
      if (!answer.startsWith("ok:")) throw new Error(answer.replace(/^error:/, ""));
      return answer.slice(3);
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return name + " (다운로드)";
  }

  ui.save.addEventListener("click", async () => {
    if (!source || saving) return;
    saving = true;
    ui.save.disabled = true;
    try {
      const size = ui.precise.checked ? LUT_PRECISE : LUT_PREVIEW;
      const name = `${baseName(source.name)}_${ui.film.value}.jpg`;
      const where = isRaw() ? await saveRaw(size, name) : await saveSrgb(size, name);
      setStatus("저장됨: " + where);
    } catch (err) {
      setStatus("저장 실패: " + err.message);
    } finally {
      saving = false;
      ui.save.disabled = !source;
    }
  });

  // ── 카메라 FTP 받기 ─────────────────────────────────────────────────────
  //
  // 서버는 안드로이드 포그라운드 서비스(FtpService)가 돌린다 — 화면이 꺼져도 받는다.
  // 여기는 상태를 그리고 시작·정지만 누른다. 상태가 바뀌면 filmSimFtpUpdate가 불린다.

  const ftp = {
    section: $("ftp"),
    box: $("ftpBox"),
    badge: $("ftpBadge"),
    toggle: $("ftpToggle"),
    error: $("ftpError"),
    hosts: $("ftpHosts"),
    port: $("ftpPort"),
    user: $("ftpUser"),
    password: $("ftpPassword"),
    newPassword: $("ftpNewPassword"),
    folder: $("ftpFolder"),
    auto: $("ftpAuto"),
    list: $("ftpList"),
    log: $("ftpLog"),
  };
  let ftpRunning = false;

  function formatSize(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(bytes / 1024)) + "KB";
  }

  function renderFtp(st) {
    ftpRunning = !!st.running;
    ftp.badge.textContent = ftpRunning ? "받는 중" : "";
    ftp.badge.className = "badge" + (ftpRunning ? " on" : "");
    ftp.toggle.textContent = ftpRunning ? "FTP 받기 정지" : "FTP 받기 시작";
    ftp.error.textContent = st.error || "";
    ftp.error.hidden = !st.error;

    const addrs = st.addresses || [];
    ftp.hosts.textContent = addrs.length
      ? addrs.map((a) => `${a.ip}  (${a.label})`).join("\n")
      : "네트워크 없음 — 핫스팟이나 Wi-Fi를 켜세요";
    ftp.hosts.style.whiteSpace = "pre-line";
    ftp.port.textContent = st.port;
    ftp.user.textContent = st.user;
    ftp.password.textContent = st.password;
    // 서버가 도는 중에 바꾸면 이미 접속한 카메라와 어긋난다 — 멈춘 뒤에만
    ftp.newPassword.disabled = ftpRunning;
    ftp.folder.textContent = st.folder;
    ftp.auto.value = st.autoOpen;

    ftp.list.innerHTML = "";
    for (const f of st.received || []) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = f.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${formatSize(f.size)} · ${new Date(f.time).toLocaleTimeString()}`;
      li.append(name, meta);
      li.addEventListener("click", () => bridge.ftpOpen(f.uri));
      ftp.list.appendChild(li);
    }
    if (!(st.received || []).length) {
      const li = document.createElement("li");
      li.className = "note";
      li.textContent = "아직 없음";
      ftp.list.appendChild(li);
    }
    ftp.log.textContent = (st.log || []).join("\n");
  }

  function initFtp() {
    ftp.section.hidden = false;
    ftp.toggle.addEventListener("click", () => {
      if (ftpRunning) bridge.ftpStop();
      else bridge.ftpStart();
    });
    ftp.newPassword.addEventListener("click", () => bridge.ftpNewPassword());
    ftp.auto.addEventListener("change", () => bridge.setFtpAutoOpen(ftp.auto.value));
    window.filmSimFtpUpdate = (json) => renderFtp(JSON.parse(json));
    const st = JSON.parse(bridge.ftpState());
    renderFtp(st);
    if (st.running) ftp.box.open = true;
  }

  // ── 시작 ────────────────────────────────────────────────────────────────

  call({ type: "catalog" })
    .then((r) => {
      catalog = r.catalog;
      const d = catalog.defaults.film;
      fillSelect(ui.film, catalog.films, (f) => `${f.name} (ISO ${f.iso})`, d.id);
      fillSelect(ui.paper, catalog.papers, (x) => x.name, d.paper);
      fillSelect(ui.scanner, catalog.scanners, (x) => x.name, d.scanner);
      fillSelect(
        ui.headroom,
        catalog.headrooms.map((h) => ({ id: String(h) })),
        (x) => `+${x.id}스톱${Number(x.id) === catalog.defaultHeadroom ? " (기본 — decode-raw.py와 같음)" : ""}`,
        String(catalog.defaultHeadroom)
      );
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
      ui.headroom.addEventListener("change", refresh);
      ui.dodgeBurn.addEventListener("change", refresh);

      if (bridge) {
        ui.rawHalfRow.hidden = false;
        ui.rawHalf.checked = bridge.rawHalfSize();
        ui.rawHalf.addEventListener("change", () => bridge.setRawHalfSize(ui.rawHalf.checked));
        initFtp();
      }

      setStatus("준비");
      window.filmSimOpenShared();
    })
    .catch((err) => setStatus("엔진 로드 실패: " + err.message));
})();
