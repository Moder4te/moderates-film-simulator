#!/usr/bin/env python3
"""안드로이드 앱의 FTP 받기 서버(`FtpServer.java`)를 **실제 FTP 클라이언트로** 시험한다.

Sony α(A7R5 등)의 FTP 전송은 카메라가 클라이언트로 접속해 STOR로 올린다. 그 흐름을
파이썬 `ftplib`로 그대로 재현한다 — 패시브(PASV·EPSV)와 액티브(PORT), 폴더 만들기·이동,
중복 확인(SIZE·LIST), 이름 바꾸기, 거절해야 하는 것(틀린 비밀번호·TLS·내려받기·지우기).

FtpServer는 안드로이드에 의존하지 않으므로 JDK만 있으면 된다. 저장소(Storage)는 임시
폴더에 쓰는 시험용으로 갈아 끼운다.

    python tools/check-ftp.py
"""
import ftplib
import io
import os
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "android", "app", "src", "main", "java", "com", "filmsim", "engine", "FtpServer.java")
USER, PASSWORD = "camera", "s3cret-pw"

HARNESS = r"""
package com.filmsim.engine;

import java.io.*;
import java.nio.file.*;

public class FtpCheckMain {
    public static void main(String[] args) throws Exception {
        Path dir = Paths.get(args[1]);
        FtpServer.Storage storage = name -> {
            Path tmp = dir.resolve(name + ".part");
            OutputStream out = Files.newOutputStream(tmp);
            return new FtpServer.Upload() {
                public OutputStream stream() { return out; }
                public String commit() throws IOException {
                    Path dst = dir.resolve(name);
                    Files.move(tmp, dst, StandardCopyOption.REPLACE_EXISTING);
                    return dst.toString();
                }
                public void abort() {
                    try { out.close(); Files.deleteIfExists(tmp); } catch (IOException ignored) {}
                }
            };
        };
        FtpServer.Listener listener = new FtpServer.Listener() {
            public void onReceived(String name, long size, String location) {
                System.out.println("RECEIVED " + name + " " + size);
                System.out.flush();
            }
            public void onLog(String message) {
                System.out.println("LOG " + message);
                System.out.flush();
            }
        };
        FtpServer s = new FtpServer(Integer.parseInt(args[0]), "%USER%", "%PASSWORD%", storage, listener);
        s.start();
        System.out.println("READY");
        System.out.flush();
        System.in.read(); // 표준 입력이 닫히면 끝
        s.stop();
    }
}
""".replace("%USER%", USER).replace("%PASSWORD%", PASSWORD)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"  {'OK  ' if cond else '❌  '}{name}" + (f"  {detail}" if detail else ""))


def login(port):
    ftp = ftplib.FTP()
    ftp.connect("127.0.0.1", port, timeout=10)
    ftp.login(USER, PASSWORD)
    return ftp


def main():
    work = tempfile.mkdtemp()
    out_dir = os.path.join(work, "out")
    cls_dir = os.path.join(work, "classes")
    os.makedirs(out_dir)
    harness = os.path.join(work, "FtpCheckMain.java")
    with open(harness, "w", encoding="utf-8") as f:
        f.write(HARNESS)
    subprocess.check_call(["javac", "-encoding", "UTF-8", "-d", cls_dir, SRC, harness])

    port = free_port()
    proc = subprocess.Popen(
        ["java", "-cp", cls_dir, "com.filmsim.engine.FtpCheckMain", str(port), out_dir],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        for line in proc.stdout:  # 시작 로그 뒤에 READY가 온다
            if line.strip() == "READY":
                break
        payload = os.urandom(3 * 1024 * 1024 + 123)  # 버퍼 경계를 일부러 피한 크기

        # ── 로그인 ──
        bad = ftplib.FTP()
        bad.connect("127.0.0.1", port, timeout=10)
        try:
            bad.login(USER, "wrong")
            check("틀린 비밀번호를 거절", False)
        except ftplib.error_perm as e:
            check("틀린 비밀번호를 거절", str(e).startswith("530"), str(e)[:3])
        bad.close()

        tls = ftplib.FTP()
        tls.connect("127.0.0.1", port, timeout=10)
        try:
            tls.sendcmd("AUTH TLS")
            check("AUTH TLS를 거절(카메라 보안 프로토콜 끔 안내)", False)
        except ftplib.error_perm as e:
            check("AUTH TLS를 거절(카메라 보안 프로토콜 끔 안내)", str(e).startswith("534"), str(e)[:3])
        tls.close()

        # ── 카메라처럼: 폴더를 만들고 들어가 패시브로 올린다 ──
        ftp = login(port)
        ftp.mkd("DCIM")
        ftp.cwd("DCIM")
        ftp.mkd("100MSDCF")
        ftp.cwd("100MSDCF")
        check("PWD가 가상 경로를 따라간다", ftp.pwd() == "/DCIM/100MSDCF", ftp.pwd())
        ftp.set_pasv(True)
        ftp.storbinary("STOR DSC00001.ARW", io.BytesIO(payload))
        got = open(os.path.join(out_dir, "DSC00001.ARW"), "rb").read()
        check("PASV STOR — 바이트가 그대로", got == payload, f"{len(got)} bytes")
        check("SIZE가 받은 크기를 돌려준다", ftp.size("DSC00001.ARW") == len(payload))
        check("NLST에 받은 파일이 보인다", ftp.nlst() == ["DSC00001.ARW"], str(ftp.nlst()))
        lines = []
        ftp.retrlines("LIST", lines.append)
        check("LIST 한 줄", len(lines) == 1 and lines[0].endswith("DSC00001.ARW"), lines[0] if lines else "")

        # EPSV
        ftp.sendcmd("TYPE I")
        ftp.af = socket.AF_INET6  # ftplib는 IPv6일 때만 EPSV를 쓴다 — 강제로
        try:
            ftp.storbinary("STOR DSC00002.JPG", io.BytesIO(payload[:1000]))
        finally:
            ftp.af = socket.AF_INET
        check("EPSV STOR", open(os.path.join(out_dir, "DSC00002.JPG"), "rb").read() == payload[:1000])

        # 액티브(PORT)
        ftp.set_pasv(False)
        ftp.storbinary("STOR DSC00003.JPG", io.BytesIO(payload[:5000]))
        check("PORT(액티브) STOR", open(os.path.join(out_dir, "DSC00003.JPG"), "rb").read() == payload[:5000])
        ftp.set_pasv(True)

        # 이름 바꾸기 — 가상 기록만 옮긴다
        ftp.rename("DSC00003.JPG", "DSC00003b.JPG")
        check("RNFR/RNTO 뒤 새 이름으로 SIZE", ftp.size("DSC00003b.JPG") == 5000)

        # 없는 파일 SIZE → 550 (카메라는 이것으로 "아직 없음"을 안다)
        try:
            ftp.size("NOPE.ARW")
            check("없는 파일 SIZE → 550", False)
        except ftplib.error_perm as e:
            check("없는 파일 SIZE → 550", str(e).startswith("550"))

        # 받기 전용
        for cmd in ("RETR DSC00001.ARW", "DELE DSC00001.ARW"):
            try:
                if cmd.startswith("RETR"):
                    ftp.retrbinary(cmd, lambda b: None)
                else:
                    ftp.sendcmd(cmd)
                check(f"{cmd.split()[0]} 거절(받기 전용)", False)
            except ftplib.error_perm as e:
                check(f"{cmd.split()[0]} 거절(받기 전용)", str(e).startswith("550"))

        # ".."로 루트 밖에 못 나간다(가상 경로)
        ftp.cwd("/../../..")
        check("'..'는 루트에서 멈춘다", ftp.pwd() == "/")
        ftp.quit()

        # ── 받다가 끊기면 반쪽 파일을 남기지 않는다 ──
        ftp = login(port)
        ftp.voidcmd("TYPE I")
        conn = ftp.transfercmd("STOR CUT.ARW")
        conn.sendall(payload[:100000])
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
        conn.close()  # RST
        try:
            ftp.voidresp()
        except ftplib.all_errors:
            pass
        time.sleep(0.3)
        leftovers = sorted(os.listdir(out_dir))
        # RST가 아니라 정상 FIN으로 끝난 경우 서버는 그것을 "다 받음"으로 볼 수밖에 없다 — FTP 스트림
        # 모드에는 길이 정보가 없다. 그래서 RST로 끊는다.
        check("끊긴 전송은 지운다", "CUT.ARW" not in leftovers and "CUT.ARW.part" not in leftovers, str(leftovers))
        ftp.close()

        proc.stdin.close()
        proc.wait(timeout=10)
        log = proc.stdout.read()
        check("받음 알림이 파일마다 한 번씩", log.count("RECEIVED") == 3, f"{log.count('RECEIVED')}회")
    finally:
        if proc.poll() is None:
            proc.kill()

    ok = all(results)
    print("\n✅ 전 항목 통과" if ok else "\n❌ 실패 항목 있음")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
