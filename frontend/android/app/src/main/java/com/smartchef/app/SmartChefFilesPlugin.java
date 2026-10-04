package com.smartchef.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

// ════════════════════════════════════════════════════════════════════════
// SmartChef — Files plugin
// App-specific Capacitor plugin that lets the Android app hand a file to
// the user, which the renderer's Blob + <a download> trick cannot do here:
// no DownloadListener is registered on the WebView, so that trick is a
// silent no-op on Android. JS side: frontend/src/lib/filesBridge.ts and
// frontend/src/lib/fileExport.ts.
//
// Both methods take a path RELATIVE TO THE APP'S CACHE DIRECTORY, never the
// file's bytes. fileExport.ts writes the file there first, in bounded
// chunks through @capacitor/filesystem (Directory.Cache), so a multi-MB
// library backup never crosses the bridge as one base64 string — the thing
// GitHttpPlugin's 512 KB rule exists to avoid.
//
//   - saveAs: the system "create document" picker (Storage Access
//     Framework). The user picks the folder and name; the app needs no
//     storage permission on any API level, unlike a write into
//     Documents/, which needs one below API 30.
//   - share:  the system share sheet, through the FileProvider declared in
//     AndroidManifest.xml (res/xml/file_paths.xml already exposes the
//     cache directory).
//
// Same convention as SafMirrorPlugin: the bridge cannot resolve a bare
// null, so a cancelled picker resolves { uri: null, displayName: null }.
// ════════════════════════════════════════════════════════════════════════

@CapacitorPlugin(name = "SmartChefFiles")
public class SmartChefFilesPlugin extends Plugin {

    /** The cache file a call names, or null when the path is missing or
     *  climbs out of the cache directory. */
    private File resolveCacheFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) return null;
        try {
            File cacheDir = getContext().getCacheDir().getCanonicalFile();
            File file = new File(cacheDir, path).getCanonicalFile();
            if (!file.getPath().startsWith(cacheDir.getPath() + File.separator)) return null;
            return file;
        } catch (IOException e) {
            return null;
        }
    }

    private static JSObject savedHandle(String uri, String displayName) {
        JSObject ret = new JSObject();
        ret.put("uri", uri == null ? JSObject.NULL : uri);
        ret.put("displayName", displayName == null ? JSObject.NULL : displayName);
        return ret;
    }

    // ── saveAs ───────────────────────────────────────────────────────────

    @PluginMethod
    public void saveAs(PluginCall call) {
        File source = resolveCacheFile(call);
        if (source == null || !source.isFile()) {
            call.reject("Nothing to save: the staged export file is missing");
            return;
        }
        String fileName = call.getString("fileName", source.getName());
        String mimeType = call.getString("mimeType", "application/octet-stream");

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        startActivityForResult(call, intent, "handleSaveAsResult");
    }

    @ActivityCallback
    private void handleSaveAsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        Uri target = data != null ? data.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            call.resolve(savedHandle(null, null)); // user backed out of the picker
            return;
        }

        File source = resolveCacheFile(call);
        if (source == null || !source.isFile()) {
            call.reject("The staged export file disappeared before it could be saved");
            return;
        }

        // Off the main thread: an activity result arrives on it, and a
        // library backup is big enough to stall the UI while it copies.
        getBridge().execute(() -> {
            try (
                InputStream in = new FileInputStream(source);
                OutputStream out = getContext().getContentResolver().openOutputStream(target, "wt")
            ) {
                if (out == null) throw new IOException("Could not open the chosen location for writing");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                out.flush();
            } catch (Exception e) {
                call.reject("Could not save the file: " + e.getMessage(), e);
                return;
            }

            DocumentFile doc = DocumentFile.fromSingleUri(getContext(), target);
            String displayName = doc != null ? doc.getName() : null;
            call.resolve(savedHandle(target.toString(), displayName != null ? displayName : source.getName()));
        });
    }

    // ── share ────────────────────────────────────────────────────────────

    @PluginMethod
    public void share(PluginCall call) {
        File source = resolveCacheFile(call);
        if (source == null || !source.isFile()) {
            call.reject("Nothing to share: the staged export file is missing");
            return;
        }
        String fileName = call.getString("fileName", source.getName());
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String title = call.getString("title", fileName);

        Uri uri;
        try {
            uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", source);
        } catch (IllegalArgumentException e) {
            call.reject("The export file is not shareable: " + e.getMessage(), e);
            return;
        }

        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mimeType);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, fileName);
        // ClipData as well as EXTRA_STREAM: since API 29 the read grant only
        // reaches the receiving app through ClipData, and without it most
        // targets open the share and then fail to read the file.
        send.setClipData(ClipData.newRawUri(fileName, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(chooser);
            // Resolves when the sheet opens: Android does not report which
            // target, if any, the user picked.
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the share sheet: " + e.getMessage(), e);
        }
    }
}
