package com.filmsim.studio;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * FilmSim Studio를 WebView에 띄운다. 페이지가 스스로 못 하는 것 둘만 여기서 한다.
 *
 *   파일 고르기   WebView는 input type=file을 눌러도 아무것도 안 띄운다 —
 *                 onShowFileChooser를 구현해 시스템 선택기를 띄워 줘야 한다
 *   파일 저장     페이지의 저장은 blob: 주소를 내려받는 것인데 WebView에는 다운로드
 *                 관리자가 없다. 자바스크립트 다리(FilmSimHost)로 바이트를 받아
 *                 MediaStore에 쓴다
 *
 * 그 밖의 모든 것(색·마감·화면)은 assets/index.html이다. 브라우저에서 여는 것과
 * 같은 파일이다(tools/build-studio.js).
 */
public class MainActivity extends Activity {
    private static final String PAGE = "file:///android_asset/index.html";
    private static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;

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
        s.setAllowFileAccess(false); // android_asset은 이것과 무관하게 열린다. 그 밖의 file://은 막는다

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 페이지는 어디로도 이동하지 않는다. 이동하려는 것은 전부 막는다
                return !PAGE.equals(request.getUrl().toString());
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
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                if (wantsJson) {
                    // 프리셋 — 기기마다 .json의 MIME을 다르게 붙여서 넓게 받는다
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_MIME_TYPES,
                            new String[]{"application/json", "text/plain", "application/octet-stream"});
                } else {
                    pick.setType("image/*"); // TIFF도 image/tiff라 여기 든다
                }
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

        if (saved == null) web.loadUrl(PAGE);
        else web.restoreState(saved);
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
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /**
     * 저장 다리. 페이지가 파일을 조각내 base64로 넘기면 MediaStore에 이어 쓴다.
     *
     * JPEG·PNG는 Pictures/FilmSim(갤러리에 보인다), 나머지(TIFF·.cube·.xmp·프리셋)는
     * Download/FilmSim에 간다. 쓰는 동안은 IS_PENDING으로 가려 두고 끝나야 드러낸다 —
     * 반쯤 쓰인 파일이 갤러리에 뜨지 않게.
     *
     * 이 메서드들은 WebView의 다리 스레드에서 불린다(UI 스레드가 아니다). 예외가
     * 자바스크립트로 넘어가면 뜻 모를 오류가 되므로 전부 잡아 값으로 돌려준다.
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
    }
}
