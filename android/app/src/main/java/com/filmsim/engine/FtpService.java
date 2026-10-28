package com.filmsim.engine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.Locale;

/**
 * 카메라 FTP 받기를 **화면이 꺼져도** 계속 돌리는 포그라운드 서비스.
 *
 * 촬영 중에는 폰이 주머니에 있다 — 앱이 화면에 있을 때만 받으면 쓸모가 없다. 그래서
 * 알림을 띄운 포그라운드 서비스로 돌리고, Wi-Fi·CPU 잠금을 잡아 절전이 소켓을
 * 끊지 않게 한다. 정지는 앱 화면이나 알림의 [정지]로.
 *
 * 상태는 정적 필드로 둔다 — 서비스와 화면(MainActivity)이 같은 프로세스라 그것으로 충분하고,
 * 화면은 Observer로 변화를 받는다.
 */
public class FtpService extends Service {

    static final String ACTION_START = "com.filmsim.engine.FTP_START";
    static final String ACTION_STOP = "com.filmsim.engine.FTP_STOP";
    static final int DEFAULT_PORT = 2121; // 1024 아래는 루트 권한이 필요하다
    static final String USER = "filmsim";

    private static final String CHANNEL = "ftp";
    private static final int NOTIFICATION_ID = 1;
    private static final int MAX_RECENT = 50;
    private static final int MAX_LOG = 20;

    interface Observer {
        void onFtpChanged();

        void onFtpReceived(String name, long size, String uri);
    }

    private static volatile FtpServer server;
    private static volatile String lastError;
    private static volatile Observer observer;
    private static final Deque<JSONObject> recent = new ArrayDeque<>();
    private static final Deque<String> log = new ArrayDeque<>();
    private static int receivedCount;

    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    static void setObserver(Observer o) {
        observer = o;
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("filmsim", MODE_PRIVATE);
    }

    /** 비밀번호. 처음 쓸 때 무작위로 만들어 둔다 — 카메라에 한 번 넣으면 계속 쓴다. */
    static String password(Context c) {
        SharedPreferences p = prefs(c);
        String pw = p.getString("ftpPassword", null);
        if (pw == null) {
            pw = newPassword();
            p.edit().putString("ftpPassword", pw).apply();
        }
        return pw;
    }

    static void regeneratePassword(Context c) {
        prefs(c).edit().putString("ftpPassword", newPassword()).apply();
    }

    private static String newPassword() {
        // 카메라 버튼으로 입력하기 쉽게 헷갈리는 글자(0/O, 1/l)를 뺀다
        final String chars = "abcdefghjkmnpqrstuvwxyz23456789";
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8; i++) sb.append(chars.charAt(r.nextInt(chars.length())));
        return sb.toString();
    }

    /** 화면에 그릴 상태 전체. */
    static String stateJson(Context c) {
        try {
            JSONObject o = new JSONObject();
            FtpServer s = server;
            o.put("running", s != null && s.running());
            o.put("port", DEFAULT_PORT);
            o.put("user", USER);
            o.put("password", password(c));
            o.put("error", lastError == null ? JSONObject.NULL : lastError);
            o.put("autoOpen", prefs(c).getString("ftpAutoOpen", "raw"));
            o.put("folder", GalleryStorage.DIR);
            JSONArray addrs = new JSONArray();
            for (String[] a : localAddresses()) {
                addrs.put(new JSONObject().put("label", a[0]).put("ip", a[1]));
            }
            o.put("addresses", addrs);
            synchronized (recent) {
                o.put("received", new JSONArray(recent));
                o.put("log", new JSONArray(log));
            }
            return o.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** 카메라가 접속할 수 있는 이 폰의 IPv4 주소들. 핫스팟과 Wi-Fi를 구분해 이름을 붙인다. */
    static java.util.List<String[]> localAddresses() {
        java.util.List<String[]> out = new java.util.ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName().toLowerCase(Locale.ROOT);
                // 모바일 데이터(rmnet·ccmni)는 카메라가 닿지 않는다
                if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("dummy") || n.startsWith("tun")) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String label = n.startsWith("ap") || n.startsWith("swlan") || n.contains("softap") ? "핫스팟"
                            : n.startsWith("wlan") ? "Wi-Fi" : n;
                    out.add(new String[] {label, a.getHostAddress()});
                }
            }
        } catch (Exception ignored) {
            // 목록을 못 얻으면 빈 채로
        }
        return out;
    }

    private static void addLog(String message) {
        synchronized (recent) {
            log.addFirst(new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new java.util.Date())
                    + "  " + message);
            while (log.size() > MAX_LOG) log.removeLast();
        }
        Observer o = observer;
        if (o != null) o.onFtpChanged();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // 5초 안에 포그라운드로 올라가야 한다 — 서버를 띄우기 전에 먼저
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        if (server == null) startServer();
        return START_NOT_STICKY;
    }

    private void startServer() {
        lastError = null;
        FtpServer s = new FtpServer(DEFAULT_PORT, USER, password(this), new GalleryStorage(this),
                new FtpServer.Listener() {
                    @Override
                    public void onReceived(String name, long size, String location) {
                        synchronized (recent) {
                            try {
                                recent.addFirst(new JSONObject().put("name", name).put("size", size)
                                        .put("uri", location).put("time", System.currentTimeMillis()));
                            } catch (JSONException ignored) {
                                // 이름·크기만이라 실패할 일이 없다
                            }
                            while (recent.size() > MAX_RECENT) recent.removeLast();
                            receivedCount++;
                        }
                        addLog("받음: " + name + " (" + (size / 1024 / 1024) + "MB)");
                        updateNotification();
                        Observer o = observer;
                        if (o != null) o.onFtpReceived(name, size, location);
                    }

                    @Override
                    public void onLog(String message) {
                        addLog(message);
                    }
                });
        try {
            s.start();
            server = s;
            acquireLocks();
        } catch (Exception e) {
            lastError = "포트 " + DEFAULT_PORT + "를 열 수 없다: " + e.getMessage();
            addLog(lastError);
            stopSelf();
        }
        updateNotification();
        Observer o = observer;
        if (o != null) o.onFtpChanged();
    }

    @SuppressWarnings("deprecation") // HIGH_PERF는 API 34에서 폐기 예고됐지만 여전히 절전 해제에 가장 확실하다
    private void acquireLocks() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "filmsim:ftp");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "filmsim:ftp");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
    }

    @Override
    public void onDestroy() {
        FtpServer s = server;
        server = null;
        if (s != null) s.stop();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        Observer o = observer;
        if (o != null) o.onFtpChanged();
        super.onDestroy();
    }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "카메라 FTP 받기",
                    NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, FtpService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);

        StringBuilder where = new StringBuilder();
        for (String[] a : localAddresses()) {
            if (where.length() > 0) where.append(" · ");
            where.append(a[1]).append(':').append(DEFAULT_PORT);
        }
        int count;
        synchronized (recent) {
            count = receivedCount;
        }
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("카메라 사진 받는 중 — " + count + "장")
                .setContentText(where.length() > 0 ? where.toString() : "네트워크 없음 — 핫스팟이나 Wi-Fi를 켜세요")
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "정지", stop).build())
                .build();
    }

    private void updateNotification() {
        if (server == null) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
    }
}
