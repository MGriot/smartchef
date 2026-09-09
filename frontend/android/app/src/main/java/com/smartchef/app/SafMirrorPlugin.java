package com.smartchef.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

// ════════════════════════════════════════════════════════════════════════
// SmartChef — SafMirror plugin
// App-specific (not published) Capacitor plugin giving standalone mode's
// folder sync a real SAF (Storage Access Framework) folder picker on
// Android, in place of the fixed Documents/SmartChef path — see
// docs/plans/2026-08-15-android-folder-sync-parity-design.md. Registered
// directly in MainActivity rather than as a separate Gradle module, since
// this is bespoke to this app, not meant for reuse.
//
// A tree URI can't be resolved back to raw filesystem paths — every read
// present here is expressed as a walk from the tree root by display name.
// list()/readFile()/writeFile()/deleteFile() land in the next stage of the
// same plan; this file covers the folder-picking half only.
//
// Native calls can't resolve a bare JS `null` (Capacitor's bridge always
// resolves an object), so cancellation/no-persisted-tree is represented as
// { uri: null, displayName: null } here — frontend/src/lib/safMirrorBridge.ts
// is what coerces that into the `SafTreeHandle | null` the rest of the app
// sees.
// ════════════════════════════════════════════════════════════════════════

@CapacitorPlugin(name = "SafMirror")
public class SafMirrorPlugin extends Plugin {

    private static final String PREFS_NAME = "SafMirrorPlugin";
    private static final String PREF_TREE_URI = "treeUri";
    private static final String PREF_TREE_DISPLAY_NAME = "treeDisplayName";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private JSObject emptyTreeHandle() {
        JSObject ret = new JSObject();
        ret.put("uri", JSObject.NULL);
        ret.put("displayName", JSObject.NULL);
        return ret;
    }

    private JSObject treeHandle(String uri, String displayName) {
        JSObject ret = new JSObject();
        ret.put("uri", uri);
        ret.put("displayName", displayName);
        return ret;
    }

    @Nullable
    private String resolveDisplayName(Uri treeUri) {
        DocumentFile doc = DocumentFile.fromTreeUri(getContext(), treeUri);
        return doc != null ? doc.getName() : null;
    }

    // ── pickTree ─────────────────────────────────────────────────────────

    @PluginMethod
    public void pickTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "handlePickTreeResult");
    }

    @ActivityCallback
    private void handlePickTreeResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        Uri treeUri = data != null ? data.getData() : null;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || treeUri == null) {
            call.resolve(emptyTreeHandle()); // user cancelled the picker
            return;
        }

        getContext().getContentResolver().takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );

        String displayName = resolveDisplayName(treeUri);
        if (displayName == null) displayName = treeUri.toString();

        prefs().edit()
            .putString(PREF_TREE_URI, treeUri.toString())
            .putString(PREF_TREE_DISPLAY_NAME, displayName)
            .apply();

        call.resolve(treeHandle(treeUri.toString(), displayName));
    }

    // ── hasPersistedTree ─────────────────────────────────────────────────

    @PluginMethod
    public void hasPersistedTree(PluginCall call) {
        String storedUri = prefs().getString(PREF_TREE_URI, null);
        if (storedUri == null) {
            call.resolve(emptyTreeHandle());
            return;
        }

        boolean stillGranted = false;
        List<UriPermission> granted = getContext().getContentResolver().getPersistedUriPermissions();
        for (UriPermission permission : granted) {
            if (permission.getUri().toString().equals(storedUri) && permission.isReadPermission() && permission.isWritePermission()) {
                stillGranted = true;
                break;
            }
        }

        if (!stillGranted) {
            // Revoked externally (app data cleared, provider uninstalled, user
            // revoked it in Android settings) — clear our stale record so the
            // next check doesn't keep reporting a tree we no longer have.
            prefs().edit().clear().apply();
            call.resolve(emptyTreeHandle());
            return;
        }

        String displayName = prefs().getString(PREF_TREE_DISPLAY_NAME, storedUri);
        call.resolve(treeHandle(storedUri, displayName));
    }

    // ── list / readFile / writeFile / deleteFile ────────────────────────
    // A tree URI has no path-addressable API — every one of these walks
    // from the tree root by display name, one segment at a time.

    // Package-private rather than private: exercised directly by
    // SafMirrorPluginTest (androidTest) and SafMirrorPluginPathTest (unit)
    // without needing a full Plugin/Bridge lifecycle.

    @Nullable
    DocumentFile resolvePath(DocumentFile root, String path, boolean createDirs) {
        if (path == null || path.isEmpty()) return root;
        DocumentFile current = root;
        for (String segment : path.split("/")) {
            if (segment.isEmpty()) continue;
            DocumentFile next = current.findFile(segment);
            if (next == null) {
                if (!createDirs) return null;
                next = current.createDirectory(segment);
                if (next == null) return null;
            }
            current = next;
        }
        return current;
    }

    static String parentPath(String path) {
        int i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(0, i) : "";
    }

    static String fileName(String path) {
        int i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(i + 1) : path;
    }

    @NonNull
    static byte[] readAllBytes(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = in.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(call.getString("uri")));
            DocumentFile dir = root != null ? resolvePath(root, call.getString("path", ""), false) : null;
            if (dir == null || !dir.isDirectory()) {
                call.reject("ENOENT: no such directory, '" + call.getString("path") + "'");
                return;
            }
            JSArray entries = new JSArray();
            for (DocumentFile child : dir.listFiles()) {
                JSObject entry = new JSObject();
                entry.put("name", child.getName());
                entry.put("isDirectory", child.isDirectory());
                entry.put("size", child.length());
                entries.put(entry);
            }
            JSObject ret = new JSObject();
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            String path = call.getString("path");
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(call.getString("uri")));
            DocumentFile parent = root != null ? resolvePath(root, parentPath(path), false) : null;
            DocumentFile file = parent != null ? parent.findFile(fileName(path)) : null;
            if (file == null) {
                call.reject("ENOENT: no such file, '" + path + "'");
                return;
            }
            try (InputStream in = getContext().getContentResolver().openInputStream(file.getUri())) {
                if (in == null) {
                    call.reject("Could not open input stream for '" + path + "'");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(readAllBytes(in), Base64.NO_WRAP));
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // Every write uses application/octet-stream and mode "wt" (truncate) —
    // git objects and JSON files alike are opaque payloads here; we never
    // rely on the OS to interpret them by MIME type, only read them back
    // ourselves by the same path.
    @PluginMethod
    public void writeFile(PluginCall call) {
        try {
            String path = call.getString("path");
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(call.getString("uri")));
            DocumentFile parent = root != null ? resolvePath(root, parentPath(path), true) : null;
            if (parent == null) {
                call.reject("Failed to create parent directories for '" + path + "'");
                return;
            }
            String name = fileName(path);
            DocumentFile file = parent.findFile(name);
            if (file == null) {
                file = parent.createFile("application/octet-stream", name);
            }
            if (file == null) {
                call.reject("Failed to create file '" + path + "'");
                return;
            }
            try (OutputStream out = getContext().getContentResolver().openOutputStream(file.getUri(), "wt")) {
                if (out == null) {
                    call.reject("Could not open output stream for '" + path + "'");
                    return;
                }
                out.write(Base64.decode(call.getString("data"), Base64.NO_WRAP));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            String path = call.getString("path");
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(call.getString("uri")));
            DocumentFile parent = root != null ? resolvePath(root, parentPath(path), false) : null;
            DocumentFile file = parent != null ? parent.findFile(fileName(path)) : null;
            if (file == null) {
                call.resolve(); // already gone — matches gitfs.ts's own unlink() tolerance
                return;
            }
            if (!file.delete()) {
                call.reject("Failed to delete '" + path + "'");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
