package com.filmsim.engine;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 엔진 화면(assets/www)을 띄우는 껍데기.
 *
 * 색(LUT 굽기)은 전부 WebView 안의 core/color가 한다. 여기는 안드로이드만 할 수 있는
 * 일뿐이다 — 사진 고르기, 공유로 넘겨받기, RAW 현상(LibRaw, RawDecoder), 결과를
 * 갤러리(Pictures/FilmSim)에 새 파일로 저장하기. 원본은 읽기만 한다.
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK = 1;
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/www/index.html";
    /** 미리보기 긴 변 — app.js PREVIEW_EDGE와 맞춘다. */
    private static final int PREVIEW_EDGE = 1600;
    private static final int JPEG_QUALITY = 95;
    private static final String PREFS = "filmsim";

    /**
     * RAW로 볼 확장자. MIME으로는 못 가른다 — 파일 관리자마다 RAW를
     * application/octet-stream으로 주기도 하고 image/x-…로 주기도 한다.
     */
    private static final Set<String> RAW_EXT = new HashSet<>(Arrays.asList(
            "dng", "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "raf", "orf", "rw2", "rwl",
            "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "mrw", "kdc", "dcr", "raw"));

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private WebView web;
    private boolean pageReady;

    // 현재 소스. kind: "" | "image" | "raw"
    private volatile String kind = "";
    private volatile Uri imageUri;
    private volatile String sourceName;
    private volatile RawDecoder raw; // worker 스레드에서만 바꾼다

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/shared/", path -> serveImage())
                .addPathHandler("/raw/", path -> serveRawPreview())
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 앱 밖으로 나가는 탐색은 막는다. 이 화면은 외부 페이지를 열 일이 없다.
                return !request.getUrl().toString().startsWith(ORIGIN);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "FilmSimAndroid");
        setContentView(web);

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
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        openSource(data.getData());
    }

    @Override
    protected void onDestroy() {
        worker.execute(() -> {
            if (raw != null) raw.close();
            raw = null;
        });
        worker.shutdown();
        web.destroy();
        super.onDestroy();
    }

    // ── 열기 ────────────────────────────────────────────────────────────────

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

    /** RAW면 현상(수 초)을 백그라운드로 돌리고, 아니면 WebView가 /shared/image로 직접 받는다. */
    private void openSource(Uri uri) {
        String name = displayName(uri);
        String mime = getContentResolver().getType(uri);
        if (isRaw(name, mime)) {
            js("filmSimStatus", "RAW 현상 중… " + name);
            final boolean half = prefs().getBoolean("rawHalf", false);
            worker.execute(() -> decodeRaw(uri, name, half));
        } else {
            imageUri = uri;
            sourceName = name;
            kind = "image";
            notifyOpened();
            worker.execute(() -> { // 앞서 연 RAW의 네이티브 버퍼를 놓는다
                if (raw != null) raw.close();
                raw = null;
            });
        }
    }

    private static boolean isRaw(String name, String mime) {
        if (mime != null && (mime.equals("image/x-adobe-dng") || mime.startsWith("image/x-") && mime.contains("raw"))) {
            return true;
        }
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        return dot >= 0 && RAW_EXT.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    /**
     * LibRaw는 파일 경로로 연다. content:// 스트림은 경로가 없으니 캐시에 복사해서
     * 연다 — 현상이 끝나면 지운다(결과는 메모리에 있다).
     */
    private void decodeRaw(Uri uri, String name, boolean half) {
        File tmp = null;
        try {
            tmp = File.createTempFile("raw", ".bin", getCacheDir());
            try (InputStream in = getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(tmp)) {
                if (in == null) throw new IllegalStateException("파일을 열 수 없다");
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            RawDecoder next = RawDecoder.decode(tmp.getAbsolutePath(), half, PREVIEW_EDGE);
            if (raw != null) raw.close();
            raw = next;
            sourceName = name;
            kind = "raw";
            notifyOpened();
        } catch (Throwable e) {
            js("filmSimStatus", "RAW 열기 실패: " + e.getMessage());
        } finally {
            if (tmp != null) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
        }
    }

    /** 화면이 떠 있으면 열라고 알린다. 아직이면 화면이 시작할 때 스스로 확인한다. */
    private void notifyOpened() {
        runOnUiThread(() -> {
            if (pageReady) web.evaluateJavascript("window.filmSimOpenShared && window.filmSimOpenShared()", null);
        });
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // 이름을 못 얻어도 사진은 열 수 있다
        }
        return uri.getLastPathSegment();
    }

    private WebResourceResponse serveImage() {
        Uri uri = imageUri;
        if (uri == null) return null;
        try {
            ContentResolver cr = getContentResolver();
            String mime = cr.getType(uri);
            InputStream in = cr.openInputStream(uri);
            return new WebResourceResponse(mime != null ? mime : "image/jpeg", null, in);
        } catch (Exception e) {
            return null;
        }
    }

    private WebResourceResponse serveRawPreview() {
        RawDecoder r = raw;
        if (r == null) return null;
        try {
            return new WebResourceResponse("application/octet-stream", null, new ByteArrayInputStream(r.preview()));
        } catch (Exception e) {
            return null;
        }
    }

    // ── 저장 ────────────────────────────────────────────────────────────────

    private interface Writer {
        void write(OutputStream out) throws Exception;
    }

    /** Pictures/FilmSim에 **새 파일로** 쓴다. 원본을 덮어쓰지 않는다. 결과는 "ok:<경로>" / "error:<사유>". */
    private String writeToGallery(String name, Writer writer) {
        String dir = Environment.DIRECTORY_PICTURES + "/FilmSim";
        ContentValues v = new ContentValues();
        v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        v.put(MediaStore.Images.Media.RELATIVE_PATH, dir);
        v.put(MediaStore.Images.Media.IS_PENDING, 1);

        ContentResolver cr = getContentResolver();
        Uri uri = cr.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (uri == null) return "error:갤러리에 항목을 만들지 못했다";
        try (OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("출력 스트림 없음");
            writer.write(out);
        } catch (Throwable e) {
            cr.delete(uri, null, null);
            return "error:" + (e instanceof OutOfMemoryError ? "메모리가 부족하다 — RAW 반해상도 현상을 켜 보세요" : e.getMessage());
        }
        v.clear();
        v.put(MediaStore.Images.Media.IS_PENDING, 0);
        cr.update(uri, v, null, null);

        toast("저장됨 — " + dir + "/" + name);
        return "ok:" + dir + "/" + name;
    }

    private void saveRaw(String lutBase64, int size, String name) {
        String answer;
        Bitmap bmp = null;
        try {
            RawDecoder r = raw;
            if (r == null) throw new IllegalStateException("열린 RAW가 없다");
            byte[] bytes = Base64.decode(lutBase64, Base64.DEFAULT);
            float[] lut = new float[bytes.length / 4];
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(lut);

            JSONObject info = new JSONObject(r.info());
            bmp = Bitmap.createBitmap(info.getInt("width"), info.getInt("height"), Bitmap.Config.ARGB_8888);
            r.apply(lut, size, bmp);
            final Bitmap out = bmp;
            answer = writeToGallery(name, o -> {
                if (!out.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, o)) throw new IllegalStateException("JPEG 인코딩 실패");
            });
        } catch (Throwable e) {
            answer = "error:" + (e instanceof OutOfMemoryError ? "메모리가 부족하다 — RAW 반해상도 현상을 켜 보세요" : e.getMessage());
        } finally {
            if (bmp != null) bmp.recycle();
        }
        js("filmSimSaveDone", answer);
    }

    // ── 공용 ────────────────────────────────────────────────────────────────

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** window[fn](text)를 부른다. 문자열은 JSON으로 감싸 그대로 넘긴다. */
    private void js(String fn, String text) {
        String call = "window." + fn + " && window." + fn + "(" + JSONObject.quote(text) + ")";
        runOnUiThread(() -> web.evaluateJavascript(call, null));
    }

    private void toast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_SHORT).show());
    }

    /** 화면 스크립트가 부르는 다리. 이름은 app.js의 window.FilmSimAndroid와 맞춘다. */
    private class Bridge {

        @JavascriptInterface
        public void pickPhoto() {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            // RAW는 image/x-…로도, application/octet-stream으로도 온다
            pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "application/octet-stream"});
            runOnUiThread(() -> {
                try {
                    startActivityForResult(pick, REQ_PICK);
                } catch (Exception e) {
                    toast("파일 선택기를 열 수 없다");
                }
            });
        }

        @JavascriptInterface
        public String sourceKind() {
            return kind;
        }

        @JavascriptInterface
        public String sharedImageName() {
            return sourceName;
        }

        @JavascriptInterface
        public String rawInfo() {
            RawDecoder r = raw;
            return r == null ? "{}" : r.info();
        }

        @JavascriptInterface
        public boolean rawHalfSize() {
            return prefs().getBoolean("rawHalf", false);
        }

        @JavascriptInterface
        public void setRawHalfSize(boolean on) {
            prefs().edit().putBoolean("rawHalf", on).apply();
        }

        /** RAW 원본 해상도 저장. 오래 걸려 비동기다 — 결과는 window.filmSimSaveDone(answer). */
        @JavascriptInterface
        public void saveRaw(String lutBase64, int size, String name) {
            worker.execute(() -> MainActivity.this.saveRaw(lutBase64, size, name));
        }

        @JavascriptInterface
        public String saveJpeg(String base64, String name) {
            byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return "error:잘못된 이미지 데이터";
            }
            return writeToGallery(name, out -> out.write(bytes));
        }
    }
}
