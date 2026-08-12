#!/usr/bin/env python3
"""`decode-raw.py`의 데스크톱 GUI 래퍼. 로직은 새로 만들지 않는다 — `decode-raw.py`를
모듈로 그대로 불러와 `load_linear` · `probe_patch` · `decode` · `selftest`를 호출한다.
같은 파이프라인을 GUI가 따로 들면 CLI와 다른 수를 낼 수 있다(이 저장소가 반복해서
피해 온 함정 — `core/color/inputs.js` 참조).

── 왜 필요한가 ────────────────────────────────────────────────────────────

`--probe x,y`의 좌표를 알아내려면 원래 다른 도구(Photoshop 스포이드 등)로 픽셀
좌표를 찾아야 했다. 미리보기를 띄우고 클릭한 자리를 그대로 좌표로 쓰면 그 단계가
없어진다.

── 브래킷 처리가 핵심이다 ──────────────────────────────────────────────────

노출 브래킷(같은 장면, 다른 스톱)을 한 번에 돌릴 때는 **기준 프레임 하나에서만
측정하고, 그 스케일을 전 프레임에 똑같이 건다.** 프레임마다 다시 측정하면 각자
"그 프레임의 그 자리"를 18%로 되돌리는 꼴이라 스톱 차이 자체가 지워진다 — 이게
정확히 이 브래킷을 찍는 이유(조건 b 실측)를 망가뜨린다. 그래서 기본 동작은
"기준 프레임에서 한 번 측정 → 고정 수치로 전 파일에 적용"이고, 서로 무관한
사진을 모아 한 번에 돌릴 때만 "파일마다 새로 측정" 체크박스를 켠다.

사용법:
    pip install rawpy numpy tifffile pillow
    python tools/decode-raw-gui.py
"""
import importlib.util
import io
import queue
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

CANVAS_MAX_W = 640
CANVAS_MAX_H = 480


def _load_decode_raw():
    """`decode-raw.py`를 모듈로 불러온다. 파일명에 하이픈이 있어 일반 import가 안 된다."""
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("decode_raw", here / "decode-raw.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DR = _load_decode_raw()


class App:
    def __init__(self, root):
        self.root = root
        root.title("decode-raw — 리니어 현상 GUI")
        root.geometry("1040x760")
        root.minsize(900, 640)

        self.files = []            # [Path, ...] 선택한 raw
        self.out_dir = None        # Path | None
        self.linear_cache = {}     # {str(path): np.ndarray} — 미리보기 측정용 캐시
        self.sizes_cache = {}      # {str(path): (w, h)} — rawpy raw.sizes, 가볍다
        self.click_xy = None       # (x, y) raw 좌표 — 어느 파일을 보든 좌표는 공유된다
        # ── 기준 프레임과 측정값은 "미리보기로 보고 있는 파일"과 분리한다 ──────
        #
        # 처음엔 "패치값 확인"이 미리보기 중인 파일을 그대로 쟀다. 그런데 여러 파일을
        # 돌아가며 값을 눈으로 확인하다 보면(정상적인 탐색이다) `measured_value`가
        # 마지막으로 본 파일 값으로 조용히 덮어써지고, "변환 시작"이 그걸 기준 프레임
        # 값인 줄 알고 배치 전체에 건다 — 브래킷의 스톱 차이가 지워지는 사고다.
        # 그래서 측정은 **명시적으로 고른 기준 프레임에만** 걸리게 분리했다.
        self.reference_path = None   # Path | None — 배치 스케일의 근거가 되는 파일
        self.measured_value = None   # 위 파일에서 잰 값. 기준 프레임이 바뀌면 초기화된다
        self.queue = queue.Queue()
        self.busy = False

        self._build_ui()
        self.root.after(80, self._poll_queue)

    # ── UI 구성 ──────────────────────────────────────────────────────────

    def _build_ui(self):
        main = ttk.Frame(self.root, padding=8)
        main.pack(fill="both", expand=True)
        main.columnconfigure(0, weight=3)
        main.columnconfigure(1, weight=2)
        main.rowconfigure(1, weight=1)

        # 왼쪽 — 미리보기
        left = ttk.Frame(main)
        left.grid(row=0, column=0, rowspan=2, sticky="nsew", padx=(0, 8))

        self.canvas = tk.Canvas(left, width=CANVAS_MAX_W, height=CANVAS_MAX_H,
                                 background="#222", cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-1>", self._on_canvas_click)
        self._tkimg = None
        self._canvas_scale = None  # 표시 이미지 → raw 픽셀 배율

        self.preview_label = ttk.Label(left, text="파일을 추가하고 목록에서 고르면 미리보기가 뜬다.")
        self.preview_label.pack(fill="x", pady=(4, 0))

        # 오른쪽 위 — 파일 목록
        files_frame = ttk.LabelFrame(main, text="RAW 파일 (목록에서 고르면 왼쪽에 미리보기)")
        files_frame.grid(row=0, column=1, sticky="nsew", pady=(0, 8))
        files_frame.rowconfigure(0, weight=1)
        files_frame.columnconfigure(0, weight=1)

        self.listbox = tk.Listbox(files_frame, selectmode="extended", height=8)
        self.listbox.grid(row=0, column=0, sticky="nsew")
        self.listbox.bind("<<ListboxSelect>>", self._on_list_select)
        sb = ttk.Scrollbar(files_frame, orient="vertical", command=self.listbox.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.listbox.config(yscrollcommand=sb.set)

        btns = ttk.Frame(files_frame)
        btns.grid(row=1, column=0, columnspan=2, sticky="ew", pady=4)
        ttk.Button(btns, text="파일 추가...", command=self._add_files).pack(side="left")
        ttk.Button(btns, text="선택 제거", command=self._remove_selected).pack(side="left", padx=4)
        ttk.Button(btns, text="목록 비우기", command=self._clear_files).pack(side="left")

        ref_row = ttk.Frame(files_frame)
        ref_row.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(2, 4))
        ttk.Label(ref_row, text="기준 프레임(측정 대상):").pack(side="left")
        self.reference_var = tk.StringVar()
        self.reference_combo = ttk.Combobox(ref_row, textvariable=self.reference_var,
                                             state="readonly", width=24)
        self.reference_combo.pack(side="left", padx=(4, 0), fill="x", expand=True)
        self.reference_combo.bind("<<ComboboxSelected>>", self._on_reference_change)

        # 오른쪽 아래 — 설정
        settings = ttk.LabelFrame(main, text="설정")
        settings.grid(row=1, column=1, sticky="nsew")
        for c in (0, 1, 2):
            settings.columnconfigure(c, weight=1)

        ttk.Label(settings, text="헤드룸").grid(row=0, column=0, sticky="w", padx=4, pady=(6, 2))
        self.headroom = tk.IntVar(value=5)
        hr_frame = ttk.Frame(settings)
        hr_frame.grid(row=0, column=1, columnspan=2, sticky="w")
        for n in (4, 5, 6):
            ttk.Radiobutton(hr_frame, text=f"+{n}스톱" + ("(기본)" if n == 5 else ""),
                             variable=self.headroom, value=n).pack(side="left", padx=2)

        self.no_card = tk.BooleanVar(value=False)
        ttk.Checkbutton(settings, text="카드 없음 — 스케일 안 걸기(엔진 노출로 맞춤)",
                         variable=self.no_card, command=self._sync_probe_state).grid(
            row=1, column=0, columnspan=3, sticky="w", padx=4, pady=2)

        ttk.Label(settings, text="기준 그레이 좌표").grid(row=2, column=0, sticky="w", padx=4)
        coord = ttk.Frame(settings)
        coord.grid(row=2, column=1, columnspan=2, sticky="w")
        self.px = tk.IntVar(value=0)
        self.py = tk.IntVar(value=0)
        self.psize = tk.IntVar(value=64)
        for label, var, width in (("X", self.px, 6), ("Y", self.py, 6), ("크기", self.psize, 4)):
            ttk.Label(coord, text=label).pack(side="left")
            e = ttk.Spinbox(coord, from_=0, to=20000, textvariable=var, width=width)
            e.pack(side="left", padx=(2, 8))
        self._probe_widgets = [coord]

        ttk.Label(settings, text="추가 노출(스톱)").grid(row=3, column=0, sticky="w", padx=4)
        self.exposure = tk.DoubleVar(value=0.0)
        ttk.Spinbox(settings, from_=-5, to=5, increment=0.1, textvariable=self.exposure,
                    width=6).grid(row=3, column=1, sticky="w")

        self.per_file_probe = tk.BooleanVar(value=False)
        ttk.Checkbutton(settings, text="파일마다 새로 측정 (브래킷 아닐 때만 — 기본은 끔)",
                         variable=self.per_file_probe).grid(
            row=4, column=0, columnspan=3, sticky="w", padx=4, pady=(6, 2))

        ttk.Button(settings, text="기준 프레임 측정 (위 콤보박스)", command=self._check_patch).grid(
            row=5, column=0, columnspan=3, sticky="ew", padx=4, pady=(6, 2))

        self.status_label = ttk.Label(settings, text="아직 측정 안 함", foreground="#555",
                                       wraplength=280, justify="left")
        self.status_label.grid(row=6, column=0, columnspan=3, sticky="w", padx=4)

        ttk.Separator(settings).grid(row=7, column=0, columnspan=3, sticky="ew", pady=8)

        ttk.Label(settings, text="출력 폴더").grid(row=8, column=0, sticky="w", padx=4)
        self.outdir_label = ttk.Label(settings, text="(첫 raw와 같은 폴더)", foreground="#555")
        self.outdir_label.grid(row=8, column=1, columnspan=2, sticky="w")
        ttk.Button(settings, text="출력 폴더 선택...", command=self._choose_outdir).grid(
            row=9, column=0, columnspan=3, sticky="ew", padx=4)

        run_frame = ttk.Frame(settings)
        run_frame.grid(row=10, column=0, columnspan=3, sticky="ew", padx=4, pady=(10, 2))
        self.run_btn = ttk.Button(run_frame, text="변환 시작", command=self._start_batch)
        self.run_btn.pack(side="left", fill="x", expand=True)
        ttk.Button(run_frame, text="자가진단", command=self._run_selftest).pack(side="left", padx=(4, 0))

        self.progress = ttk.Progressbar(settings, mode="determinate")
        self.progress.grid(row=11, column=0, columnspan=3, sticky="ew", padx=4, pady=(6, 2))

        # 로그
        log_frame = ttk.LabelFrame(main, text="로그")
        log_frame.grid(row=2, column=0, columnspan=2, sticky="nsew", pady=(8, 0))
        main.rowconfigure(2, weight=1)
        log_frame.rowconfigure(0, weight=1)
        log_frame.columnconfigure(0, weight=1)
        self.log = tk.Text(log_frame, height=10, state="disabled", wrap="word")
        self.log.grid(row=0, column=0, sticky="nsew")
        lsb = ttk.Scrollbar(log_frame, orient="vertical", command=self.log.yview)
        lsb.grid(row=0, column=1, sticky="ns")
        self.log.config(yscrollcommand=lsb.set)

    # ── 파일 목록 ────────────────────────────────────────────────────────

    def _add_files(self):
        paths = filedialog.askopenfilenames(
            title="RAW 파일 선택 (같은 장면 브래킷이면 한 번에)",
            filetypes=[("RAW", "*.ARW *.CR2 *.CR3 *.NEF *.RAF *.DNG *.ORF *.RW2"), ("전체", "*.*")],
        )
        if not paths:
            return
        was_empty = not self.files
        for p in paths:
            pp = Path(p)
            if pp not in self.files:
                self.files.append(pp)
                self.listbox.insert("end", pp.name)
        if was_empty and self.files:
            self.listbox.selection_set(0)
            self._load_preview(self.files[0])
        self._refresh_reference_combo()

    def _remove_selected(self):
        sel = list(self.listbox.curselection())
        for i in reversed(sel):
            del self.files[i]
            self.listbox.delete(i)
        self.click_xy = None
        self._refresh_reference_combo()
        self._log("선택한 파일을 목록에서 뺐다")

    def _clear_files(self):
        self.files.clear()
        self.listbox.delete(0, "end")
        self.canvas.delete("all")
        self.click_xy = None
        self.linear_cache.clear()
        self.sizes_cache.clear()
        self._refresh_reference_combo()

    def _refresh_reference_combo(self):
        """파일 목록이 바뀔 때마다 기준 프레임 콤보박스를 맞춘다.

        기준 프레임이 목록에서 사라졌으면(선택 제거·목록 비우기) 첫 파일로 되돌리고
        측정값을 지운다 — 사라진 파일의 값을 계속 배치에 쓰면 조용히 틀린다.
        """
        names = [p.name for p in self.files]
        self.reference_combo["values"] = names
        if self.reference_path not in self.files:
            self.reference_path = self.files[0] if self.files else None
            self.measured_value = None
        if self.reference_path is not None:
            self.reference_combo.current(self.files.index(self.reference_path))
        else:
            self.reference_var.set("")

    def _on_reference_change(self, event=None):
        idx = self.reference_combo.current()
        if idx < 0 or idx >= len(self.files):
            return
        new_ref = self.files[idx]
        if new_ref == self.reference_path:
            return
        self.reference_path = new_ref
        self.measured_value = None
        self.status_label.config(text=f"기준 프레임이 {new_ref.name}(으)로 바뀜 — 다시 측정하십시오.")
        self._log(f"[기준 프레임] {new_ref.name}")

    def _on_list_select(self, event=None):
        sel = self.listbox.curselection()
        if sel:
            self._load_preview(self.files[sel[0]])

    def _on_canvas_click(self, event):
        # 파일을 하나도 안 골랐을 때의 자리 표시자. 미리보기가 뜨면
        # `_load_preview`가 `_on_canvas_click_real`로 바꿔 건다.
        pass

    # ── 미리보기 ─────────────────────────────────────────────────────────
    #
    # 미리보기는 목록에서 고른 아무 파일이나 볼 수 있다 — 좌표를 찍기 위한 것뿐이라
    # 브래킷 전체가 같은 프레이밍이면 어느 파일을 보든 상관없다. **기준 프레임**(측정
    # 대상)은 이것과 분리된 별도 콤보박스(`self.reference_path`)로 고른다.

    def _load_preview(self, path):
        try:
            import rawpy
            from PIL import Image, ImageTk
        except ImportError as e:
            messagebox.showerror("의존성 없음", f"미리보기에는 rawpy·Pillow가 필요합니다.\n{e}")
            return

        try:
            with rawpy.imread(str(path)) as raw:
                w, h = raw.sizes.iwidth, raw.sizes.iheight
                thumb = raw.extract_thumb()
        except Exception as e:
            self._log(f"⚠️ {path.name} 미리보기 실패: {e}")
            return

        self.sizes_cache[str(path)] = (w, h)

        if thumb.format.name == "JPEG":
            im = Image.open(io.BytesIO(thumb.data))
        else:
            im = Image.frombytes("RGB", (thumb.data.shape[1], thumb.data.shape[0]), thumb.data.tobytes())

        scale = min(CANVAS_MAX_W / im.width, CANVAS_MAX_H / im.height, 1.0)
        disp = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))))
        self._tkimg = ImageTk.PhotoImage(disp)
        self.canvas.delete("all")
        self.canvas.config(width=disp.width, height=disp.height)
        self.canvas.create_image(0, 0, anchor="nw", image=self._tkimg)

        # 썸네일 표시 크기 → raw 좌표(rawpy 출력 기준, 썸네일과 몇 %씩 어긋날 수 있어
        # 카메라 임베디드 썸네일 크기가 아니라 **표시 크기 대 raw.sizes**로 비율을 잡는다.
        self._canvas_scale = (w / disp.width, h / disp.height)
        self._preview_path = path
        self.preview_label.config(text=f"{path.name} — raw {w}×{h} (클릭해서 기준 그레이 위치 지정)")

        self.canvas.bind("<Button-1>", self._on_canvas_click_real)
        if self.click_xy:
            self._draw_marker()

    def _on_canvas_click_real(self, event):
        if not self._canvas_scale:
            return
        sx, sy = self._canvas_scale
        rx, ry = int(event.x * sx), int(event.y * sy)
        self.px.set(rx)
        self.py.set(ry)
        self.click_xy = (rx, ry)
        self._draw_marker()

    def _draw_marker(self):
        self.canvas.delete("marker")
        if not self.click_xy or not self._canvas_scale:
            return
        rx, ry = self.click_xy
        sx, sy = self._canvas_scale
        cx, cy = rx / sx, ry / sy
        r = 6
        self.canvas.create_oval(cx - r, cy - r, cx + r, cy + r, outline="#ff3b30", width=2, tags="marker")
        self.canvas.create_line(cx - r - 4, cy, cx + r + 4, cy, fill="#ff3b30", tags="marker")
        self.canvas.create_line(cx, cy - r - 4, cx, cy + r + 4, fill="#ff3b30", tags="marker")

    def _sync_probe_state(self):
        state = "disabled" if self.no_card.get() else "normal"
        for frame in self._probe_widgets:
            for child in frame.winfo_children():
                child.config(state=state)

    # ── 패치값 확인 ──────────────────────────────────────────────────────

    def _check_patch(self):
        path = self.reference_path
        if not path:
            messagebox.showwarning("파일 없음", "먼저 RAW 파일을 추가하십시오.")
            return
        if self.no_card.get():
            messagebox.showinfo("카드 없음", "지금 '카드 없음'이 켜져 있다 — 측정할 것이 없다.")
            return
        if self.busy:
            return
        self.busy = True
        self.status_label.config(text=f"{path.name} 측정 중... (raw 디코드에 몇 초~수십 초 걸린다)")
        x, y, size = self.px.get(), self.py.get(), self.psize.get()
        headroom = self.headroom.get()
        threading.Thread(target=self._check_patch_worker, args=(path, x, y, size, headroom), daemon=True).start()

    def _check_patch_worker(self, path, x, y, size, headroom):
        try:
            key = str(path)
            if key not in self.linear_cache:
                self.linear_cache[key] = DR.load_linear(str(path))
            lin = self.linear_cache[key]
            measured, box = DR.probe_patch(lin, f"{x},{y},{size}")
            target = 2.0 ** -headroom
            import math
            stops = math.log2(target / measured) if measured > 0 else float("nan")

            if path != self.reference_path:
                # 측정하는 동안 콤보박스에서 기준 프레임을 바꿨다 — 이 결과는 버린다.
                # 안 버리면 방금 고른 새 기준이 옛 파일의 측정값을 들고 시작한다.
                self.queue.put(("status", "기준 프레임이 측정 도중 바뀌어 결과를 버렸다 — 다시 누르십시오."))
                self.queue.put(("log", f"[측정 취소] {path.name}: 기준 프레임이 바뀜"))
                return

            self.measured_value = measured
            msg = (f"기준: {path.name}\n"
                   f"패치 {box[0]},{box[1]} {box[2]}×{box[3]}  평균 선형 {measured:.6f}\n"
                   f"스케일 ×{target / measured:.4f} ({stops:+.2f}스톱) → 헤드룸 +{headroom}스톱 자리에 놓임\n"
                   f"이 값을 배치 전체(다른 스톱 파일 포함)에 고정 적용한다")
            self.queue.put(("status", msg))
            self.queue.put(("log", f"[측정 — 기준: {path.name}] {msg.splitlines()[1]}"))
        except Exception as e:
            self.queue.put(("status", f"측정 실패: {e}"))
            self.queue.put(("log", f"⚠️ [측정 실패] {path.name}: {e}"))
        finally:
            self.queue.put(("busy_off", None))

    # ── 출력 폴더 ────────────────────────────────────────────────────────

    def _choose_outdir(self):
        d = filedialog.askdirectory(title="출력 폴더")
        if d:
            self.out_dir = Path(d)
            self.outdir_label.config(text=str(self.out_dir))

    # ── 배치 실행 ────────────────────────────────────────────────────────

    def _start_batch(self):
        if self.busy:
            return
        if not self.files:
            messagebox.showwarning("파일 없음", "RAW 파일을 먼저 추가하십시오.")
            return
        no_card = self.no_card.get()
        per_file = self.per_file_probe.get()
        if not no_card and self.measured_value is None and not per_file:
            messagebox.showwarning(
                "측정 안 됨",
                "'기준 프레임 측정'을 먼저 누르거나, '카드 없음' 또는\n"
                "'파일마다 새로 측정'을 켜십시오.")
            return

        outdir = self.out_dir or self.files[0].parent
        headroom = self.headroom.get()
        exposure = self.exposure.get()
        x, y, size = self.px.get(), self.py.get(), self.psize.get()
        fixed_midgray = None if (no_card or per_file) else self.measured_value
        probe_spec = f"{x},{y},{size}" if (per_file and not no_card) else None

        # 이게 진짜 안전장치다 — 뭘 기준으로 얼마나 밀지 실행 직전에 한 번 더 보여준다.
        # 콤보박스를 잘못 골라 놓고 눌렀어도 여기서 잡힌다.
        if no_card:
            summary = "스케일 없음 — 화이트 레벨 기준 선형 그대로(카드 없음)"
        elif per_file:
            summary = f"좌표 ({x},{y},{size})에서 파일마다 새로 측정"
        else:
            target = 2.0 ** -headroom
            summary = (f"기준 프레임: {self.reference_path.name}\n"
                       f"측정값 {self.measured_value:.6f} → 스케일 ×{target / self.measured_value:.4f}\n"
                       f"이 스케일을 {len(self.files)}개 파일 전체(다른 스톱 포함)에 동일하게 건다")
        if not messagebox.askyesno(
            "변환 확인",
            f"{summary}\n\n헤드룸 +{headroom}스톱, 출력 폴더 {outdir}\n\n진행할까?"
        ):
            return

        self.busy = True
        self.run_btn.config(state="disabled")
        self.progress.config(maximum=len(self.files), value=0)
        self._log(f"── 변환 시작: {len(self.files)}개 파일, 헤드룸 +{headroom}스톱 → {outdir}")

        threading.Thread(
            target=self._batch_worker,
            args=(list(self.files), outdir, headroom, exposure, fixed_midgray, probe_spec),
            daemon=True,
        ).start()

    def _batch_worker(self, files, outdir, headroom, exposure, fixed_midgray, probe_spec):
        outdir.mkdir(parents=True, exist_ok=True)
        for i, path in enumerate(files, 1):
            out_path = outdir / f"{path.stem}_linear-h{headroom}.tiff"
            self.queue.put(("progress", i))
            self.queue.put(("log", f"[{i}/{len(files)}] {path.name} → {out_path.name}"))
            buf = io.StringIO()
            try:
                real_stderr = sys.stderr
                sys.stderr = buf
                try:
                    DR.decode(str(path), str(out_path), headroom, exposure, fixed_midgray, probe_spec)
                finally:
                    sys.stderr = real_stderr
                for line in buf.getvalue().splitlines():
                    self.queue.put(("log", "    " + line))
            except Exception as e:
                self.queue.put(("log", f"    ⚠️ 실패: {e}"))
        self.queue.put(("log", "✅ 배치 완료"))
        self.queue.put(("busy_off", None))

    # ── 자가진단 ─────────────────────────────────────────────────────────

    def _run_selftest(self):
        if self.busy:
            return
        self.busy = True
        threading.Thread(target=self._selftest_worker, daemon=True).start()

    def _selftest_worker(self):
        buf = io.StringIO()
        real_stdout = sys.stdout
        sys.stdout = buf
        try:
            DR.selftest()
        finally:
            sys.stdout = real_stdout
        self.queue.put(("log", "── 자가진단 ──"))
        for line in buf.getvalue().splitlines():
            self.queue.put(("log", line))
        self.queue.put(("busy_off", None))

    # ── 로그 · 큐 폴링 ───────────────────────────────────────────────────

    def _log(self, line):
        self.log.config(state="normal")
        self.log.insert("end", line + "\n")
        self.log.see("end")
        self.log.config(state="disabled")

    def _poll_queue(self):
        try:
            while True:
                kind, payload = self.queue.get_nowait()
                if kind == "log":
                    self._log(payload)
                elif kind == "status":
                    self.status_label.config(text=payload)
                elif kind == "progress":
                    self.progress.config(value=payload)
                elif kind == "busy_off":
                    self.busy = False
                    self.run_btn.config(state="normal")
        except queue.Empty:
            pass
        self.root.after(80, self._poll_queue)


def main():
    root = tk.Tk()
    try:
        style = ttk.Style()
        if "vista" in style.theme_names():
            style.theme_use("vista")
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
