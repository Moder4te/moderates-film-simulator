package com.filmsim.studio;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * FilmSim Studio를 WebView에 띄운다. 색·마감·RAW 현상은 전부 페이지
 * (assets/index.html = dist/studio — 브라우저에서 여는 것과 같은 파일)가 하고,
 * 여기는 **안드로이드만 할 수 있는 일**을 이어 준다.
 *
 *   파일 고르기     WebView는 input type=file을 눌러도 아무것도 안 띄운다
 *   넘겨받기        갤러리의 "공유"·"다음으로 열기", 그리고 FTP로 방금 받은 사진.
 *                   페이지가 /shared/<번호>를 fetch하면 그 파일을 흘려 준다
 *   저장            페이지의 내려받기(blob:)는 WebView에서 갈 곳이 없다. 다리(FilmSimHost)로
 *                   바이트를 받아 MediaStore에 쓴다
 *   카메라 FTP 받기 FtpService(포그라운드 서비스)를 켜고 끄고 상태를 페이지에 알린다
 *
 * 예전에는 엔진 전용 화면과 NDK(LibRaw·LUT 적용)가 여기 있었다. RAW 현상이
 * WebAssembly가 되어 페이지로 들어가면서 네이티브 코드는 없어졌다 — 색을 계산하는
 * 코드가 자바·C++ 쪽에 한 줄도 없다.
 */
public class MainActivity extends Activity {
    /**
     * 페이지의 출처. 실재하지 않는 주소이고(구글이 이 용도로 비워 둔 도메인) 요청은 전부
     * 아래 shouldInterceptRequest가 가로채 앱 안에서 답한다 — 네트워크로 나가지 않는다.
     * file:// 대신 이렇게 하는 것은 /shared/를 **같은 출처**로 fetch하기 위해서다.
     */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 1;
    private static final String PREFS = "filmsim";

    /** RAW로 볼 확장자 — FTP로 받은 것을 자동으로 열지 가를 때 쓴다(core/io/rawdecoder.js와 같은 목록). */
    private static final Set<String> RAW_EXT = new HashSet<>(Arrays.asList(
            "dng", "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "raf", "orf", "rw2", "rwl",
            "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "mrw", "kdc", "dcr", "raw"));

    private WebView web;
    private boolean pageReady;
    private ValueCallback<Uri[]> pendingPick;

    // 페이지에 넘겨줄 파일. 번호가 바뀌면 새 파일이다 — 페이지는 번호를 붙여 fetch한다
    private volatile Uri sharedUri;
    private volatile String sharedName;
    private volatile int sharedToken;

    private final FtpService.Observer ftpObserver = new FtpService.Observer() {
        @Override
        public void onFtpChanged() {
            js("filmSimFtpUpdate", FtpService.stateJson(MainActivity.this));
        }

        @Override
        public void onFtpReceived(String name, long size, String uri) {
            onFtpChanged();
            String mode = prefs().getString("ftpAutoOpen", "raw");
            boolean raw = isRaw(name);
            boolean image = raw || GalleryStorage.mimeFor(name).startsWith("image/");
            if (mode.equals("all") && image || mode.equals("raw") && raw) {
                runOnUiThread(() -> openSource(Uri.parse(uri)));
            }
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF16171A);
        web = new WebView(this);
        web.setBackgroundColor(0xFF16171A);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Android 15부터 앱이 상태 표시줄·내비게이션 바 **밑까지** 그려진다. 그만큼 안쪽으로
        // 밀지 않으면 맨 위 도구 줄이 시계 밑에 깔린다. 키보드(ime)도 같은 방식으로 온다.
        // WebView는 자기 padding을 무시하므로 감싼 FrameLayout을 민다.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 프리셋·마지막 설정(localStorage)
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false); // content://는 아래 /shared/로만 내준다

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null ? "/" : u.getPath();
                if (path.startsWith("/shared/")) return serveShared();
                return serveAsset(path.equals("/") ? "index.html" : path.substring(1));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 페이지는 어디로도 이동하지 않는다. 앱 밖으로 나가는 것은 전부 막는다
                return !HOST.equals(request.getUrl().getHost());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;

                boolean wantsJson = false;
                for (String type : params.getAcceptTypes()) {
                    if (type != null && type.toLowerCase(Locale.ROOT).contains("json")) wantsJson = true;
                }
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                // RAW는 image/x-…로도, application/octet-stream으로도 온다(파일 관리자마다 다르다).
                // 프리셋(.json)도 기기마다 MIME이 달라 넓게 받는다
                pick.putExtra(Intent.EXTRA_MIME_TYPES, wantsJson
                        ? new String[]{"application/json", "text/plain", "application/octet-stream"}
                        : new String[]{"image/*", "application/octet-stream"});
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(pick, PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingPick = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Host(), "FilmSimHost");
        FtpService.setObserver(ftpObserver);

        handleIntent(getIntent());
        web.loadUrl(START);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = pendingPick;
        pendingPick = null;
        if (callback == null) return;

        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        // 취소해도 반드시 답한다 — 안 하면 다음부터 파일 선택기가 다시는 안 뜬다
        callback.onReceiveValue(picked);
    }

    @Override
    protected void onDestroy() {
        FtpService.setObserver(null); // 서비스는 계속 돈다 — 화면이 없을 뿐
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ── 넘겨받기 ────────────────────────────────────────────────────────────

    /** SEND / VIEW 인텐트로 넘겨받은 사진. */
    @SuppressWarnings("deprecation") // 클래스 인자판은 API 33부터다. minSdk가 29라 옛 판을 쓴다
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        }
        if (uri != null) openSource(uri);
    }

    /**
     * 이 파일을 열라고 페이지에 알린다. 페이지가 아직 안 떴으면 떴을 때 스스로
     * 확인한다(Host.pendingShared).
     */
    private void openSource(Uri uri) {
        sharedName = displayName(uri);
        sharedUri = uri;
        final int token = ++sharedToken;
        runOnUiThread(() -> {
            if (pageReady) {
                web.evaluateJavascript("window.filmSimOpenShared && window.filmSimOpenShared("
                        + JSONObject.quote(sharedName) + "," + token + ")", null);
            }
        });
    }

    private static boolean isRaw(String name) {
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        return dot >= 0 && RAW_EXT.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // 이름을 못 얻어도 사진은 열 수 있다
        }
        return uri.getLastPathSegment();
    }

    // ── 페이지가 요청하는 것에 답하기 ───────────────────────────────────────

    private WebResourceResponse serveAsset(String name) {
        try {
            String type = name.endsWith(".html") ? "text/html"
                    : name.endsWith(".js") ? "text/javascript"
                    : name.endsWith(".png") ? "image/png"
                    : name.endsWith(".webmanifest") ? "application/manifest+json"
                    : "application/octet-stream";
            boolean text = type.startsWith("text/") || type.endsWith("json");
            return new WebResourceResponse(type, text ? "utf-8" : null, getAssets().open(name));
        } catch (Exception e) {
            return notFound();
        }
    }

    private WebResourceResponse serveShared() {
        Uri uri = sharedUri;
        if (uri == null) return notFound();
        try {
            ContentResolver cr = getContentResolver();
            String mime = cr.getType(uri);
            if (mime != null && (mime.contains("heif") || mime.contains("heic"))) {
                // WebView(크롬)는 HEIF를 못 푼다 — 안드로이드 디코더로 풀어 JPEG(최고 품질)로 내준다.
                // ⚠️ 10bit HEIF는 여기서 8bit가 된다. 계조가 중요하면 RAW를 쓴다
                Bitmap bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(cr, uri),
                        (decoder, info, src) -> decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
                ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 100, jpeg);
                bmp.recycle();
                return new WebResourceResponse("image/jpeg", null, new ByteArrayInputStream(jpeg.toByteArray()));
            }
            InputStream in = cr.openInputStream(uri);
            if (in == null) return notFound();
            return new WebResourceResponse(mime != null ? mime : "application/octet-stream", null, in);
        } catch (Exception e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    // ── 공용 ────────────────────────────────────────────────────────────────

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** window[fn](text)를 부른다. 문자열은 JSON으로 감싸 그대로 넘긴다. */
    private void js(String fn, String text) {
        String call = "window." + fn + " && window." + fn + "(" + JSONObject.quote(text) + ")";
        runOnUiThread(() -> {
            if (pageReady) web.evaluateJavascript(call, null);
        });
    }

    /**
     * 페이지가 부르는 다리(window.FilmSimHost). 이 메서드들은 WebView의 다리 스레드에서
     * 불린다(UI 스레드가 아니다). 예외가 자바스크립트로 넘어가면 뜻 모를 오류가 되므로
     * 전부 잡아 값으로 돌려준다.
     */
    private final class Host {
        private final class Job {
            Uri item;
            OutputStream out;
            String where;
        }

        private final Map<Integer, Job> jobs = new HashMap<>();
        private int nextId = 1;
        private String lastError = "";

        // ── 넘겨받은 파일 ──

        /** 페이지가 뜨기 전에 온 공유·열기 요청. 없으면 빈 문자열, 있으면 {"name","token"}. */
        @JavascriptInterface
        public String pendingShared() {
            if (sharedUri == null) return "";
            try {
                return new JSONObject().put("name", sharedName).put("token", sharedToken).toString();
            } catch (Exception e) {
                return "";
            }
        }

        // ── 저장 ──
        //
        // JPEG·PNG는 Pictures/FilmSim(갤러리에 보인다), 나머지(TIFF·.cube·.xmp·프리셋)는
        // Download/FilmSim에 간다. 쓰는 동안은 IS_PENDING으로 가려 두고 끝나야 드러낸다 —
        // 반쯤 쓰인 파일이 갤러리에 뜨지 않게. 원본은 읽기만 한다.

        @JavascriptInterface
        public synchronized int begin(String name, String mime) {
            try {
                String lower = name.toLowerCase(Locale.ROOT);
                boolean picture = lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png");
                // MIME과 확장자가 안 맞으면 MediaStore가 확장자를 덧붙인다(.cube → .cube.txt).
                // 모르는 형식은 octet-stream으로 둬 이름을 지킨다
                String type = lower.endsWith(".png") ? "image/png"
                        : picture ? "image/jpeg"
                        : lower.endsWith(".tif") || lower.endsWith(".tiff") ? "image/tiff"
                        : lower.endsWith(".json") ? "application/json"
                        : "application/octet-stream";
                String dir = (picture ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/FilmSim";

                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                ContentResolver resolver = getContentResolver();
                Uri collection = picture
                        ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Job job = new Job();
                job.item = resolver.insert(collection, values);
                if (job.item == null) throw new IllegalStateException("저장할 자리를 만들지 못했습니다");
                job.out = resolver.openOutputStream(job.item);
                if (job.out == null) throw new IllegalStateException("파일을 열지 못했습니다");
                job.where = dir + "/" + name;
                int id = nextId++;
                jobs.put(id, job);
                return id;
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                return -1;
            }
        }

        @JavascriptInterface
        public synchronized boolean append(int id, String base64) {
            Job job = jobs.get(id);
            if (job == null) { lastError = "없는 저장 작업"; return false; }
            try {
                job.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                return false;
            }
        }

        /** @return 저장된 자리("Pictures/FilmSim/…"). 실패하면 빈 문자열 */
        @JavascriptInterface
        public synchronized String finish(int id) {
            Job job = jobs.remove(id);
            if (job == null) { lastError = "없는 저장 작업"; return ""; }
            try {
                job.out.close();
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(job.item, done, null, null);
                return job.where;
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                try { getContentResolver().delete(job.item, null, null); } catch (Exception ignored) { }
                return "";
            }
        }

        /** 중간에 실패했을 때 — 반쯤 쓰인 파일을 지운다. */
        @JavascriptInterface
        public synchronized void abort(int id) {
            Job job = jobs.remove(id);
            if (job == null) return;
            try { job.out.close(); } catch (Exception ignored) { }
            try { getContentResolver().delete(job.item, null, null); } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public synchronized String lastError() {
            return lastError;
        }

        // ── 카메라 FTP 받기 ──

        @JavascriptInterface
        public String ftpState() {
            return FtpService.stateJson(MainActivity.this);
        }

        @JavascriptInterface
        public void ftpStart() {
            runOnUiThread(() -> {
                // 알림이 없으면 서비스가 돌고 있는지 알 길이 없다(Android 13+는 권한이 필요)
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2);
                }
                startForegroundService(new Intent(MainActivity.this, FtpService.class)
                        .setAction(FtpService.ACTION_START));
            });
        }

        @JavascriptInterface
        public void ftpStop() {
            startService(new Intent(MainActivity.this, FtpService.class).setAction(FtpService.ACTION_STOP));
        }

        @JavascriptInterface
        public void ftpNewPassword() {
            FtpService.regeneratePassword(MainActivity.this);
            ftpObserver.onFtpChanged();
        }

        @JavascriptInterface
        public void setFtpAutoOpen(String mode) {
            prefs().edit().putString("ftpAutoOpen", mode).apply();
        }

        /** 받은 목록에서 고른 것을 연다. */
        @JavascriptInterface
        public void ftpOpen(String uri) {
            runOnUiThread(() -> openSource(Uri.parse(uri)));
        }
    }
}
