/**
 * Android 앱 안에서만 도는 부분 — 껍데기(apps/android)가 심어 둔 `window.FilmSimHost`가
 * 있을 때만 켜진다. 브라우저에서는 이 파일이 아무 일도 하지 않는다.
 *
 *   넘겨받기        갤러리의 "공유"·"다음으로 열기", FTP로 방금 받은 사진. 껍데기가
 *                   `filmSimOpenShared(이름, 번호)`를 부르면 `/shared/<번호>`를 받아 연다
 *   카메라 FTP 받기 패널. 서버는 껍데기의 포그라운드 서비스가 돌린다(화면이 꺼져도 받는다) —
 *                   여기는 상태를 그리고 시작·정지만 누른다
 *
 * 저장은 여기 없다 — `main.js`의 `download`가 같은 다리로 한다.
 */

const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

const size = (bytes) =>
  bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(bytes / 1024)) + "KB";

// Sony α7R V 기준 설정 순서. 메뉴 이름은 펌웨어·언어에 따라 조금 다르다
const GUIDE = `
<ol>
  <li>폰에서 <b>모바일 핫스팟</b>을 켠다(밖에서). 집·스튜디오에선 카메라와 폰을 같은 Wi-Fi에 붙여도 된다.</li>
  <li>카메라 <b>MENU → 네트워크 → Wi-Fi → 액세스 포인트 설정</b>에서 폰 핫스팟(또는 그 Wi-Fi)에 연결한다.</li>
  <li><b>MENU → 네트워크 → 전송/원격 → FTP 전송 기능 → 서버 설정</b>에서 서버 하나를 고르고:
    <ul>
      <li>호스트 이름 = 위 <b>서버 주소</b> (핫스팟이면 「핫스팟」 줄)</li>
      <li>보안 프로토콜 = <b>끔</b> (이 앱은 평문 FTP만 받는다)</li>
      <li>포트 = 위 <b>포트</b></li>
      <li>사용자 정보 = 위 사용자 이름·비밀번호</li>
      <li>패시브 모드 항목이 있으면 = <b>켬</b></li>
      <li>디렉터리 = 아무거나 (폰에는 한 폴더로 모인다)</li>
    </ul></li>
  <li><b>FTP 기능</b>을 켜고, 찍는 대로 보내려면 <b>자동 FTP 전송</b>을 켠다. 보낼 파일 종류는 <b>RAW+JPEG</b>을 권한다 — RAW만 보내면 장당 수십~백MB라 느리다.</li>
  <li>이 화면에서 <b>FTP 받기 시작</b>을 누른 뒤 카메라에서 연결한다.</li>
</ol>`;

/**
 * @param {object} host  window.FilmSimHost
 * @param {object} app   { openBuffer(buffer, name, type, reload), status(text, kind) }
 * @param {HTMLElement} panel  패널을 붙일 자리
 */
function init(host, app, panel) {
  // ── 넘겨받기 ──
  //
  // 연사로 여러 장이 몰려오면 하나씩 다 열 이유가 없다 — 여는 중에 새 것이 오면
  // **가장 최근 것만** 기억했다가 연다(RAW 한 장 현상이 수 초다).
  let opening = false;
  let waiting = null;

  async function load(token) {
    const res = await fetch(`/shared/${token}`);
    if (!res.ok) throw new Error(`넘겨받은 파일을 읽지 못했습니다 (${res.status})`);
    return { buffer: await res.arrayBuffer(), type: res.headers.get("content-type") || "" };
  }

  async function pump() {
    if (opening) return;
    opening = true;
    try {
      while (waiting) {
        const job = waiting;
        waiting = null;
        try {
          app.status(`${job.name} 받는 중…`);
          const got = await load(job.token);
          // RAW 현상 크기를 바꾸면 같은 파일을 다시 열어야 한다 — 다시 받는 법을 같이 넘긴다
          await app.openBuffer(got.buffer, job.name, got.type, async () => (await load(job.token)).buffer);
        } catch (e) {
          app.status(e.message, "error");
        }
      }
    } finally {
      opening = false;
    }
  }

  window.filmSimOpenShared = (name, token) => {
    waiting = { name: name || "photo", token };
    pump();
  };
  // 페이지가 뜨기 전에 온 공유(앱을 "공유"로 처음 띄운 경우)
  try {
    const first = host.pendingShared && host.pendingShared();
    if (first) { const j = JSON.parse(first); window.filmSimOpenShared(j.name, j.token); }
  } catch (e) { /* 없으면 그만이다 */ }

  if (!host.ftpState) return; // FTP가 없는 껍데기

  // ── 카메라 FTP 받기 ──
  let running = false;
  const badge = el("span", { class: "badge" });
  const toggle = el("button", { class: "primary", text: "FTP 받기 시작" });
  const error = el("p", { class: "hint warn", hidden: true });
  const hosts = el("dd"), port = el("dd"), user = el("dd"), folder = el("dd"), password = el("span");
  const renew = el("button", { class: "small", text: "새로 만들기", onclick: () => host.ftpNewPassword() });
  const auto = el("select", {},
    el("option", { value: "raw", text: "RAW만 (RAW+JPEG로 보낼 때 권장)" }),
    el("option", { value: "all", text: "모든 사진" }),
    el("option", { value: "off", text: "안 함" }));
  const list = el("ul", { class: "ftplist" });
  const log = el("pre", { class: "ftplog" });
  const box = el("details", { id: "sec-ftp" },
    el("summary", {}, el("span", { text: "카메라에서 바로 받기 (FTP)" }), badge),
    el("div", { class: "body" },
      el("p", { class: "hint", text: "카메라가 찍는 대로 이 폰으로 보낸다. 화면이 꺼져도 받는다." }),
      el("div", { class: "actions" }, toggle),
      error,
      el("dl", { class: "ftpinfo" },
        el("dt", { text: "서버 주소" }), hosts, el("dt", { text: "포트" }), port,
        el("dt", { text: "사용자 이름" }), user,
        el("dt", { text: "비밀번호" }), el("dd", {}, password, " ", renew),
        el("dt", { text: "저장 위치" }), folder),
      el("label", { class: "row" }, el("span", { class: "name", text: "받으면 자동으로 열기" }), auto),
      el("h3", { text: "받은 사진 — 눌러서 열기" }), list,
      el("details", { class: "guide" }, el("summary", { text: "Sony α7R V 설정 방법" }), el("div", { html: GUIDE }),
        el("small", { text: "메뉴 이름은 카메라 펌웨어·언어 설정에 따라 조금 다를 수 있다." })),
      el("details", { class: "guide" }, el("summary", { text: "기록" }), log)));

  function render(st) {
    running = !!st.running;
    badge.textContent = running ? "받는 중" : "";
    badge.className = "badge" + (running ? " on" : "");
    toggle.textContent = running ? "FTP 받기 정지" : "FTP 받기 시작";
    error.textContent = st.error || "";
    error.hidden = !st.error;
    const addrs = st.addresses || [];
    hosts.textContent = addrs.length
      ? addrs.map((a) => `${a.ip}  (${a.label})`).join("\n")
      : "네트워크 없음 — 핫스팟이나 Wi-Fi를 켜세요";
    port.textContent = st.port;
    user.textContent = st.user;
    password.textContent = st.password;
    // 서버가 도는 중에 바꾸면 이미 접속한 카메라와 어긋난다 — 멈춘 뒤에만
    renew.disabled = running;
    folder.textContent = st.folder;
    auto.value = st.autoOpen;
    const items = (st.received || []).map((f) =>
      el("li", { onclick: () => host.ftpOpen(f.uri) },
        el("span", { text: f.name }),
        el("span", { class: "meta", text: `${size(f.size)} · ${new Date(f.time).toLocaleTimeString()}` })));
    list.replaceChildren(...(items.length ? items : [el("li", { class: "none", text: "아직 없음" })]));
    log.textContent = (st.log || []).join("\n");
  }

  toggle.addEventListener("click", () => (running ? host.ftpStop() : host.ftpStart()));
  auto.addEventListener("change", () => host.setFtpAutoOpen(auto.value));
  window.filmSimFtpUpdate = (json) => { try { render(JSON.parse(json)); } catch (e) { /* 깨진 상태는 건너뛴다 */ } };
  panel.prepend(box);
  try {
    const st = JSON.parse(host.ftpState());
    render(st);
    if (st.running) box.open = true;
  } catch (e) { /* 상태를 못 읽어도 패널은 둔다 */ }
}

module.exports = { init };
