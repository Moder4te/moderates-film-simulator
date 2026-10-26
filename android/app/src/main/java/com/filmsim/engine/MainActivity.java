package com.filmsim.engine;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.InputStream;
import java.io.OutputStream;

/**
 * 엔진 화면(assets/www)을 띄우는 껍데기.
 *
 * 색 계산은 전부 WebView 안의 core/color가 한다. 여기는 안드로이드만 할 수 있는
 * 세 가지뿐이다 — 사진 고르기(파일 선택기), 공유로 넘겨받은 사진 내주기,
 * 결과를 갤러리(Pictures/FilmSim)에 새 파일로 저장하기. 원본은 읽기만 한다.
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK = 1;
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/www/index.html";

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private volatile Uri sharedUri;
    private volatile String sharedName;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/shared/", path -> openShared())
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

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

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "사진 선택"), REQ_PICK);
                } catch (Exception e) {
                    pickCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "FilmSimAndroid");
        setContentView(web);

        takeShared(getIntent());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 이미 떠 있는 화면에 공유가 들어오면 화면에게 열라고 알린다.
        if (takeShared(intent) && pageReady) {
            web.evaluateJavascript("window.filmSimOpenShared && window.filmSimOpenShared()", null);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || pickCallback == null) return;
        Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        pickCallback.onReceiveValue(uri != null ? new Uri[] {uri} : null);
        pickCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** SEND / VIEW 인텐트에서 사진 URI를 꺼내 둔다. 꺼냈으면 true. */
    @SuppressWarnings("deprecation") // 클래스 인자판은 API 33부터다. minSdk가 29라 옛 판을 쓴다
    private boolean takeShared(Intent intent) {
        if (intent == null) return false;
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        }
        if (uri == null) return false;
        sharedUri = uri;
        sharedName = displayName(uri);
        return true;
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

    /** /shared/image 요청에 공유받은 사진을 그대로 흘려준다. */
    private WebResourceResponse openShared() {
        Uri uri = sharedUri;
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

    private void toast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_SHORT).show());
    }

    /** 화면 스크립트가 부르는 다리. 이름은 app.js의 window.FilmSimAndroid와 맞춘다. */
    private class Bridge {

        @JavascriptInterface
        public boolean hasSharedImage() {
            return sharedUri != null;
        }

        @JavascriptInterface
        public String sharedImageName() {
            return sharedName;
        }

        /**
         * JPEG를 Pictures/FilmSim에 **새 파일로** 저장한다. 원본을 덮어쓰지 않는다.
         * 결과는 "ok:<경로>" 또는 "error:<사유>".
         */
        @JavascriptInterface
        public String saveJpeg(String base64, String name) {
            byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return "error:잘못된 이미지 데이터";
            }

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
                out.write(bytes);
            } catch (Exception e) {
                cr.delete(uri, null, null);
                return "error:" + e.getMessage();
            }
            v.clear();
            v.put(MediaStore.Images.Media.IS_PENDING, 0);
            cr.update(uri, v, null, null);

            toast("저장됨 — " + dir + "/" + name);
            return "ok:" + dir + "/" + name;
        }
    }
}
