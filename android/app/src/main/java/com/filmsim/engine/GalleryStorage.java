package com.filmsim.engine;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;

/**
 * FTP로 받은 파일을 갤러리(DCIM/FilmSim)에 쓴다. 카메라 폴더 구조는 따르지 않고 한 곳에
 * 모은다 — 같은 이름이 오면 MediaStore가 " (1)"을 붙여 따로 둔다(덮어쓰지 않는다).
 *
 * 받는 동안은 IS_PENDING이라 갤러리에 반쪽 파일이 보이지 않고, 끊기면 지운다.
 */
final class GalleryStorage implements FtpServer.Storage {

    static final String DIR = Environment.DIRECTORY_DCIM + "/FilmSim";
    private static final String FALLBACK_DIR = Environment.DIRECTORY_DOWNLOADS + "/FilmSim";

    private final ContentResolver cr;

    GalleryStorage(Context context) {
        this.cr = context.getContentResolver();
    }

    static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "hif":
            case "heif":
            case "heic":
                return "image/heif";
            case "arw":
            case "srf":
            case "sr2":
                return "image/x-sony-arw";
            case "dng":
                return "image/x-adobe-dng";
            case "cr2":
                return "image/x-canon-cr2";
            case "cr3":
                return "image/x-canon-cr3";
            case "nef":
                return "image/x-nikon-nef";
            case "raf":
                return "image/x-fuji-raf";
            case "orf":
                return "image/x-olympus-orf";
            case "rw2":
                return "image/x-panasonic-rw2";
            case "mp4":
                return "video/mp4";
            case "mov":
                return "video/quicktime";
            default:
                return "application/octet-stream";
        }
    }

    @Override
    public FtpServer.Upload begin(String fileName) throws IOException {
        String mime = mimeFor(fileName);
        Uri uri = null;
        if (mime.startsWith("image/") || mime.startsWith("video/")) {
            Uri collection = mime.startsWith("video/")
                    ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            uri = insert(collection, fileName, mime, DIR);
        }
        // 기기의 MIME 표가 모르는 형식(일부 RAW)은 사진 모음이 거절한다 — 다운로드로 받는다
        if (uri == null) {
            uri = insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                    fileName, "application/octet-stream", FALLBACK_DIR);
        }
        if (uri == null) throw new IOException("갤러리에 항목을 만들지 못했다");

        final Uri target = uri;
        final OutputStream out;
        try {
            out = cr.openOutputStream(target);
            if (out == null) throw new IOException("출력 스트림 없음");
        } catch (IOException | RuntimeException e) {
            cr.delete(target, null, null);
            throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage());
        }

        return new FtpServer.Upload() {
            @Override
            public OutputStream stream() {
                return out;
            }

            @Override
            public String commit() throws IOException {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (cr.update(target, v, null, null) != 1) throw new IOException("마무리 실패");
                return target.toString();
            }

            @Override
            public void abort() {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // 지울 것이다
                }
                cr.delete(target, null, null);
            }
        };
    }

    private Uri insert(Uri collection, String name, String mime, String dir) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        try {
            return cr.insert(collection, v);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
