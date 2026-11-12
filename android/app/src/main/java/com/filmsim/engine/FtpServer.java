package com.filmsim.engine;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 카메라가 사진을 **올려 보내는** 받기 전용 FTP 서버.
 *
 * Sony α(A7R5 등)의 "FTP 전송"은 카메라가 클라이언트다 — 찍으면 카메라가 서버에
 * 접속해 STOR로 파일을 올린다. 그래서 폰이 서버가 된다.
 *
 * ── 범위 ──────────────────────────────────────────────────────────────────
 *
 * **받기만 한다.** 내려받기(RETR)·지우기(DELE)는 없다 — 폰의 다른 파일을 네트워크로
 * 내줄 길을 처음부터 만들지 않는다. 폴더는 가상이다: 카메라가 CWD·MKD로 자기
 * 폴더 구조를 만들어도 실제 저장은 Storage가 정한 한 곳에 평평하게 한다. LIST·SIZE는
 * 이 서버가 이번에 **받은 파일**만 보여 준다(카메라가 중복 확인에 쓴다).
 *
 * 평문 FTP다. AUTH TLS는 거절한다 — 카메라의 "보안 프로토콜"을 끄고 쓴다. 대신
 * 비밀번호는 무작위로 만들고, 폰 핫스팟·같은 Wi-Fi 같은 로컬 망에서 쓰는 것을 전제한다.
 *
 * 안드로이드에 의존하지 않는다 — 저장은 Storage로 받는다. 그래서 PC에서 실제 FTP
 * 클라이언트로 시험할 수 있다(tools/check-ftp.py).
 */
final class FtpServer {

    /** 받은 파일을 어디에 쓰는가. 안드로이드에서는 MediaStore(GalleryStorage). */
    interface Storage {
        Upload begin(String fileName) throws IOException;
    }

    interface Upload {
        OutputStream stream();
        /** 끝까지 받았다. 받은 파일의 위치(안드로이드는 content:// URI)를 돌려준다. */
        String commit() throws IOException;
        /** 중간에 끊겼다. 반쯤 받은 파일을 남기지 않는다. */
        void abort();
    }

    interface Listener {
        void onReceived(String name, long size, String location);
        void onLog(String message);
    }

    /** 받은 파일 기록. 가상 경로(카메라가 본 경로) → 크기·시각. */
    private static final class Entry {
        final long size;
        final long time;
        final String location;

        Entry(long size, long time, String location) {
            this.size = size;
            this.time = time;
            this.location = location;
        }
    }

    private static final int MAX_SESSIONS = 8;
    private static final int DATA_TIMEOUT_MS = 30_000;
    private static final int IDLE_TIMEOUT_MS = 10 * 60_000;

    private final int port;
    private final String user;
    private final String password;
    private final Storage storage;
    private final Listener listener;

    private final Map<String, Entry> received = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final List<Socket> clients = new ArrayList<>();
    private volatile ServerSocket server;

    FtpServer(int port, String user, String password, Storage storage, Listener listener) {
        this.port = port;
        this.user = user;
        this.password = password;
        this.storage = storage;
        this.listener = listener;
    }

    /** 포트를 연다. 실패하면 예외(포트를 이미 다른 앱이 쓰는 경우 등). */
    synchronized void start() throws IOException {
        if (server != null) return;
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(port));
        server = s;
        pool.execute(this::acceptLoop);
        log("FTP 서버 시작 — 포트 " + port);
    }

    synchronized void stop() {
        ServerSocket s = server;
        server = null;
        closeQuietly(s);
        synchronized (clients) {
            for (Socket c : clients) closeQuietly(c);
            clients.clear();
        }
        pool.shutdownNow();
        log("FTP 서버 정지");
    }

    boolean running() {
        return server != null;
    }

    int port() {
        return port;
    }

    private void acceptLoop() {
        ServerSocket s = server;
        while (s != null && !s.isClosed()) {
            try {
                Socket c = s.accept();
                synchronized (clients) {
                    if (clients.size() >= MAX_SESSIONS) {
                        reply(c, "421 접속이 너무 많다");
                        closeQuietly(c);
                        continue;
                    }
                    clients.add(c);
                }
                pool.execute(() -> new Session(c).run());
            } catch (IOException e) {
                if (server == null) return; // 정지
            }
        }
    }

    private void log(String message) {
        if (listener != null) listener.onLog(message);
    }

    private static void reply(Socket c, String line) {
        try {
            c.getOutputStream().write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // 닫히는 중
        }
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
            // 이미 닫혔다
        }
    }

    /** 경로 정규화. 가상 경로라 실제 파일 시스템에 닿지 않는다 — ".."는 루트에서 멈춘다. */
    static String resolve(String cwd, String arg) {
        String path = arg == null || arg.isEmpty() ? cwd : arg.startsWith("/") ? arg : cwd + "/" + arg;
        List<String> parts = new ArrayList<>();
        for (String p : path.replace('\\', '/').split("/")) {
            if (p.isEmpty() || p.equals(".")) continue;
            if (p.equals("..")) {
                if (!parts.isEmpty()) parts.remove(parts.size() - 1);
            } else {
                parts.add(p);
            }
        }
        return "/" + String.join("/", parts);
    }

    static String baseName(String path) {
        int i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(i + 1) : path;
    }

    private final class Session implements Runnable {
        private final Socket control;
        private Writer out;
        private boolean loggedIn;
        private String pendingUser;
        private int failures;
        private String cwd = "/";
        private String renameFrom;

        // 데이터 연결. PASV면 passive가, PORT면 activeAddress가 있다
        private ServerSocket passive;
        private InetSocketAddress activeAddress;

        Session(Socket control) {
            this.control = control;
        }

        @Override
        public void run() {
            String peer = control.getInetAddress().getHostAddress();
            try {
                control.setSoTimeout(IDLE_TIMEOUT_MS);
                BufferedReader in = new BufferedReader(
                        new InputStreamReader(control.getInputStream(), StandardCharsets.UTF_8));
                out = new OutputStreamWriter(control.getOutputStream(), StandardCharsets.UTF_8);
                send("220 FilmSim FTP 준비");
                log("접속: " + peer);
                for (String line; (line = in.readLine()) != null; ) {
                    if (!handle(line)) break;
                }
            } catch (IOException e) {
                // 끊김·타임아웃 — 세션 끝
            } finally {
                closeQuietly(passive);
                closeQuietly(control);
                synchronized (clients) {
                    clients.remove(control);
                }
                log("연결 종료: " + peer);
            }
        }

        private void send(String line) throws IOException {
            out.write(line + "\r\n");
            out.flush();
        }

        /** 한 줄 처리. false면 세션을 닫는다. */
        private boolean handle(String line) throws IOException {
            int sp = line.indexOf(' ');
            String cmd = (sp < 0 ? line : line.substring(0, sp)).trim().toUpperCase(Locale.ROOT);
            String arg = sp < 0 ? "" : line.substring(sp + 1).trim();

            switch (cmd) {
                case "USER":
                    pendingUser = arg;
                    loggedIn = false;
                    send("331 비밀번호를 보내라");
                    return true;
                case "PASS":
                    if (user.equals(pendingUser) && password.equals(arg)) {
                        loggedIn = true;
                        send("230 로그인됨");
                        log("로그인: " + control.getInetAddress().getHostAddress());
                    } else {
                        failures++;
                        send("530 사용자명 또는 비밀번호가 틀렸다");
                        log("로그인 실패 — 카메라에 넣은 사용자명·비밀번호를 확인");
                        if (failures >= 5) return false;
                    }
                    return true;
                case "AUTH":
                    // 카메라의 "보안 프로토콜"이 켜져 있으면 여기로 온다
                    send("534 TLS를 지원하지 않는다 — 카메라의 보안 프로토콜을 끈다");
                    log("카메라가 TLS(FTPS)를 요청했다 — 카메라 FTP 설정에서 보안 프로토콜을 끄세요");
                    return true;
                case "QUIT":
                    send("221 안녕");
                    return false;
                case "SYST":
                    send("215 UNIX Type: L8");
                    return true;
                case "FEAT":
                    send("211-기능");
                    send(" SIZE");
                    send(" MDTM");
                    send(" EPSV");
                    send(" PASV");
                    send(" UTF8");
                    send("211 끝");
                    return true;
                case "OPTS":
                    send(arg.toUpperCase(Locale.ROOT).startsWith("UTF8") ? "200 UTF8 켬" : "501 모르는 옵션");
                    return true;
                case "NOOP":
                    send("200 OK");
                    return true;
                default:
                    break;
            }

            if (!loggedIn) {
                send("530 먼저 로그인하라");
                return true;
            }

            switch (cmd) {
                case "PWD":
                case "XPWD":
                    send("257 \"" + cwd.replace("\"", "\"\"") + "\"");
                    break;
                case "CWD":
                case "XCWD":
                    cwd = resolve(cwd, arg);
                    send("250 " + cwd);
                    break;
                case "CDUP":
                case "XCUP":
                    cwd = resolve(cwd, "..");
                    send("250 " + cwd);
                    break;
                case "MKD":
                case "XMKD":
                    send("257 \"" + resolve(cwd, arg).replace("\"", "\"\"") + "\" 만듦");
                    break;
                case "RMD":
                case "XRMD":
                    send("250 OK");
                    break;
                case "TYPE":
                case "MODE":
                case "STRU":
                    send("200 OK");
                    break;
                case "ALLO":
                    send("202 필요 없음");
                    break;
                case "REST":
                    // 이어 받기는 지원하지 않는다. 0은 "처음부터"라 받아 준다
                    send("0".equals(arg) ? "350 처음부터" : "502 이어 받기 미지원");
                    break;
                case "PASV":
                    openPassive(false);
                    break;
                case "EPSV":
                    openPassive(true);
                    break;
                case "PORT":
                    activeAddress = parsePort(arg);
                    closeQuietly(passive);
                    passive = null;
                    send(activeAddress != null ? "200 PORT OK" : "501 PORT 형식이 틀렸다");
                    break;
                case "EPRT":
                    activeAddress = parseEprt(arg);
                    closeQuietly(passive);
                    passive = null;
                    send(activeAddress != null ? "200 EPRT OK" : "501 EPRT 형식이 틀렸다");
                    break;
                case "STOR":
                    store(arg);
                    break;
                case "LIST":
                case "NLST":
                    list(arg, cmd.equals("NLST"));
                    break;
                case "SIZE": {
                    Entry e = received.get(resolve(cwd, arg));
                    send(e != null ? "213 " + e.size : "550 없음");
                    break;
                }
                case "MDTM": {
                    Entry e = received.get(resolve(cwd, arg));
                    send(e != null ? "213 " + mdtm(e.time) : "550 없음");
                    break;
                }
                case "RNFR":
                    renameFrom = resolve(cwd, arg);
                    send(received.containsKey(renameFrom) ? "350 새 이름을 보내라" : "550 없음");
                    break;
                case "RNTO": {
                    // 갤러리의 실제 파일 이름은 그대로 두고 가상 기록만 옮긴다 — 카메라가
                    // 임시 이름으로 올린 뒤 바꾸는 경우 중복 확인이 맞게 동작하도록.
                    Entry e = renameFrom == null ? null : received.remove(renameFrom);
                    if (e != null) received.put(resolve(cwd, arg), e);
                    renameFrom = null;
                    send(e != null ? "250 OK" : "503 RNFR 먼저");
                    break;
                }
                case "DELE":
                case "RETR":
                case "APPE":
                case "STOU":
                    send("550 이 서버는 받기만 한다");
                    break;
                case "STAT":
                    send("211 FilmSim FTP — 받은 파일 " + received.size() + "개");
                    break;
                case "HELP":
                    send("214 USER PASS PWD CWD MKD TYPE PASV EPSV PORT EPRT STOR LIST NLST SIZE MDTM QUIT");
                    break;
                default:
                    send("502 지원하지 않는 명령");
                    break;
            }
            return true;
        }

        private void openPassive(boolean extended) throws IOException {
            closeQuietly(passive);
            activeAddress = null;
            InetAddress local = control.getLocalAddress();
            passive = new ServerSocket(0, 1, local);
            passive.setSoTimeout(DATA_TIMEOUT_MS);
            int p = passive.getLocalPort();
            if (extended) {
                send("229 패시브 (|||" + p + "|)");
                return;
            }
            if (!(local instanceof Inet4Address)) {
                send("425 IPv4 연결에서만 PASV — EPSV를 쓰라");
                return;
            }
            byte[] a = local.getAddress();
            send(String.format(Locale.ROOT, "227 패시브 (%d,%d,%d,%d,%d,%d)",
                    a[0] & 0xff, a[1] & 0xff, a[2] & 0xff, a[3] & 0xff, p >> 8, p & 0xff));
        }

        /**
         * 데이터 연결. ⚠️ PORT로 받은 주소는 **제어 연결의 상대와 같은 호스트일 때만** 쓴다 —
         * 아니면 이 서버로 제3의 호스트에 연결을 거는 "FTP 바운스"가 된다.
         */
        private Socket openData() throws IOException {
            if (passive != null) {
                Socket s = passive.accept();
                closeQuietly(passive);
                passive = null;
                if (!s.getInetAddress().equals(control.getInetAddress())) {
                    closeQuietly(s);
                    throw new IOException("다른 주소에서 데이터 연결");
                }
                return s;
            }
            if (activeAddress != null) {
                if (!activeAddress.getAddress().equals(control.getInetAddress())) {
                    throw new IOException("PORT 주소가 접속한 주소와 다르다");
                }
                Socket s = new Socket();
                s.connect(activeAddress, DATA_TIMEOUT_MS);
                activeAddress = null;
                return s;
            }
            throw new IOException("PASV/PORT 먼저");
        }

        private void store(String arg) throws IOException {
            String path = resolve(cwd, arg);
            String name = baseName(path);
            if (name.isEmpty()) {
                send("501 파일 이름이 없다");
                return;
            }
            Upload up;
            try {
                up = storage.begin(name);
            } catch (IOException e) {
                send("553 저장할 수 없다: " + e.getMessage());
                log("저장 실패 " + name + ": " + e.getMessage());
                return;
            }
            Socket data;
            try {
                send("150 받는 중");
                data = openData();
            } catch (IOException e) {
                up.abort();
                send("425 데이터 연결 실패");
                log("데이터 연결 실패 — 카메라의 패시브 모드를 켜 보세요 (" + e.getMessage() + ")");
                return;
            }
            long size = 0;
            String location;
            try (Socket d = data; InputStream in = d.getInputStream(); OutputStream o = up.stream()) {
                d.setSoTimeout(DATA_TIMEOUT_MS);
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) {
                    o.write(buf, 0, n);
                    size += n;
                }
            } catch (IOException e) {
                up.abort();
                send("426 받다가 끊겼다");
                log("받다가 끊김: " + name);
                return;
            }
            try {
                location = up.commit();
            } catch (IOException e) {
                up.abort();
                send("451 저장 마무리 실패: " + e.getMessage());
                return;
            }
            received.put(path, new Entry(size, System.currentTimeMillis(), location));
            send("226 받음");
            if (listener != null) listener.onReceived(name, size, location);
        }

        private void list(String arg, boolean namesOnly) throws IOException {
            // "-la" 같은 옵션은 무시한다
            String target = arg.startsWith("-") ? "" : arg;
            String dir = resolve(cwd, target);
            StringBuilder sb = new StringBuilder();
            SimpleDateFormat fmt = new SimpleDateFormat("MMM dd HH:mm", Locale.US);
            for (Map.Entry<String, Entry> e : received.entrySet()) {
                String p = e.getKey();
                int cut = p.lastIndexOf('/');
                String parent = cut <= 0 ? "/" : p.substring(0, cut);
                if (!parent.equals(dir) && !p.equals(dir)) continue;
                String n = baseName(p);
                if (namesOnly) {
                    sb.append(n).append("\r\n");
                } else {
                    sb.append(String.format(Locale.ROOT, "-rw-r--r-- 1 ftp ftp %d %s %s\r\n",
                            e.getValue().size, fmt.format(new Date(e.getValue().time)), n));
                }
            }
            Socket data;
            try {
                send("150 목록");
                data = openData();
            } catch (IOException e) {
                send("425 데이터 연결 실패");
                return;
            }
            try (Socket d = data) {
                d.getOutputStream().write(sb.toString().getBytes(StandardCharsets.UTF_8));
            } catch (SocketException ignored) {
                // 상대가 먼저 닫음
            }
            send("226 끝");
        }

        private InetSocketAddress parsePort(String arg) {
            String[] p = arg.split(",");
            if (p.length != 6) return null;
            try {
                String host = p[0].trim() + "." + p[1].trim() + "." + p[2].trim() + "." + p[3].trim();
                int port = Integer.parseInt(p[4].trim()) * 256 + Integer.parseInt(p[5].trim());
                return new InetSocketAddress(InetAddress.getByName(host), port);
            } catch (Exception e) {
                return null;
            }
        }

        private InetSocketAddress parseEprt(String arg) {
            if (arg.length() < 2) return null;
            String[] p = arg.split(java.util.regex.Pattern.quote(String.valueOf(arg.charAt(0))));
            // |1|ip|port| → ["", "1", ip, port]
            if (p.length < 4) return null;
            try {
                return new InetSocketAddress(InetAddress.getByName(p[2]), Integer.parseInt(p[3]));
            } catch (Exception e) {
                return null;
            }
        }
    }

    private static String mdtm(long time) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMddHHmmss", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(time));
    }
}
