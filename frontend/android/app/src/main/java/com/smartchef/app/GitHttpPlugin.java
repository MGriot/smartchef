package com.smartchef.app;

import android.util.Base64;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

// ════════════════════════════════════════════════════════════════════════
// SmartChef — GitHttp plugin
// App-specific (not published) Capacitor plugin that makes a single HTTP
// request from native Android code rather than the WebView's fetch() — see
// gitRemoteTransport.ts's header for why: browsers enforce CORS on
// fetch()/XHR made by web content, but that restriction doesn't exist for
// native app code at all (CORS is a browser policy, not a network-layer
// one), so routing isomorphic-git's git-remote HTTP traffic through here
// reaches GitHub/GitLab/self-hosted servers directly — no CORS proxy
// needed. Electron's equivalent lives in electron/src/index.ts's
// `smartchef-http-request` IPC handler (Node's fetch() has the same
// no-CORS property, for the same reason).
//
// ── Why response bodies do NOT simply cross as base64 ──────────────────
// This file used to buffer the whole response with a ByteArrayOutputStream,
// base64 it into one String, and hand it back as a single JSON field, on
// the stated assumption that "even a sizeable git push/fetch payload for a
// personal recipe library is nowhere near the size where buffering the
// whole thing in memory would actually matter."
//
// That assumption was wrong in the one case that matters most: the FIRST
// sync on a new device. There is no local history to negotiate against, so
// the server answers with a pack covering the entire repository — measured
// at ~16 MB for a real library of 48 recipes, because the history, not the
// data, is what sets that size. Crossing the Capacitor bridge multiplied it
// several times over, in large contiguous allocations: a doubling
// ByteArrayOutputStream, its toByteArray() copy, a ~22 MB base64 String,
// Capacitor's own JSON serialization of that String (see MessageHandler's
// postMessage(data.toString())), the WebView's JSON.parse of it, and
// finally the decoded bytes again in the JS heap. The WebView renderer was
// killed partway through, which the user sees as the app dying on the
// first-run "Checking this folder for existing profiles…" screen rather
// than as any kind of error — the JS that awaits it never gets to run.
//
// So a large body is streamed to a file in the app's cache directory and
// the renderer pulls it back in bounded slices (readBodyChunk below), which
// caps peak memory on both sides regardless of how big the pack is. Small
// bodies — every ref advertisement, every push ack, the geocode responses
// this plugin is also reused for — still cross inline exactly as before,
// because for them the file round-trip would be pure overhead.
// ════════════════════════════════════════════════════════════════════════

@CapacitorPlugin(name = "GitHttp")
public class GitHttpPlugin extends Plugin {

    /** Below this, a response still crosses inline as base64 in one piece.
     *  Chosen well above every non-pack git response (a ref advertisement
     *  for a repository this size is a few KB) and well below the size
     *  where the multiplied copies described above become a problem. */
    private static final int INLINE_MAX_BYTES = 512 * 1024;

    /** Subdirectory of the app cache holding spilled response bodies. */
    private static final String SPILL_DIR = "git-http-bodies";

    /** A spilled body is normally deleted by releaseBody() as soon as the
     *  renderer finishes reading it. If the app dies mid-fetch — which is
     *  precisely the failure this change exists to stop — that call never
     *  happens, so anything left from a previous run is swept on the next
     *  request rather than accumulating in the cache directory forever. */
    private static final long SPILL_MAX_AGE_MS = 60 * 60 * 1000L;

    private File spillDir() throws IOException {
        File dir = new File(getContext().getCacheDir(), SPILL_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir.getAbsolutePath());
        }
        return dir;
    }

    private void sweepStaleSpills(File dir) {
        File[] existing = dir.listFiles();
        if (existing == null) return;
        long cutoff = System.currentTimeMillis() - SPILL_MAX_AGE_MS;
        for (File f : existing) {
            if (f.isFile() && f.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    /** Only ever hand out, or act on, paths inside the spill directory.
     *  readBodyChunk/releaseBody take a path from the renderer, and the
     *  renderer is web content — so the path is resolved and checked
     *  against the spill directory rather than trusted, which keeps these
     *  two methods from being a general "read or delete any file the app
     *  can reach" primitive. */
    private File resolveSpillFile(String path) throws IOException {
        if (path == null) throw new IOException("No body file given");
        File dir = spillDir();
        File file = new File(path).getCanonicalFile();
        String prefix = dir.getCanonicalPath() + File.separator;
        if (!file.getPath().startsWith(prefix)) {
            throw new IOException("Refusing to touch a file outside the response cache");
        }
        return file;
    }

    /** How often to tell the renderer how far along a download is. Time-
     *  based rather than byte-based: on a slow link a byte interval goes
     *  quiet for seconds at a time, which is exactly when someone is most
     *  likely to conclude the app has hung. */
    private static final long PROGRESS_INTERVAL_MS = 250;

    /** Copies `in` to `out`, returning how many bytes moved, and reports
     *  progress as it goes. A fixed 8 KB transfer buffer, so this is flat
     *  in memory no matter the size — the whole point of spilling to a
     *  file at all.
     *
     *  The progress events matter more than they look: the renderer gets
     *  the response only once this method has finished, so without them
     *  isomorphic-git cannot report anything either (its own progress comes
     *  from sideband messages it parses while READING the body, which by
     *  then is already downloaded). A first-run clone consequently showed
     *  "connecting" for its whole duration and was reported as a hang. */
    private long copyStreamReportingProgress(@NonNull InputStream in, @NonNull OutputStream out,
                                             String url, long contentLength) throws IOException {
        byte[] chunk = new byte[8192];
        long total = 0;
        int read;
        long lastReportAt = 0;
        while ((read = in.read(chunk)) != -1) {
            out.write(chunk, 0, read);
            total += read;
            long now = System.currentTimeMillis();
            if (now - lastReportAt >= PROGRESS_INTERVAL_MS) {
                lastReportAt = now;
                emitProgress(url, total, contentLength);
            }
        }
        emitProgress(url, total, contentLength); // final, exact figure
        return total;
    }

    private void emitProgress(String url, long loaded, long total) {
        JSObject event = new JSObject();
        event.put("url", url != null ? url : "");
        event.put("loaded", loaded);
        // -1 from getContentLength() means the server is using chunked
        // encoding and has not said how big this is — which GitHub does for
        // upload-pack. Normalised to 0 so the renderer shows bytes counting
        // up without a progress bar, rather than a bar stuck at -100%.
        event.put("total", Math.max(0, total));
        notifyListeners("gitHttpProgress", event);
    }

    private static byte[] readFully(@NonNull File file, int length) throws IOException {
        byte[] bytes = new byte[length];
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.readFully(bytes);
        }
        return bytes;
    }

    @PluginMethod
    public void request(PluginCall call) {
        HttpURLConnection conn = null;
        File spill = null;
        try {
            File dir = spillDir();
            sweepStaleSpills(dir);

            URL url = new URL(call.getString("url"));
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(call.getString("method", "GET"));
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(60000);

            JSObject headers = call.getObject("headers", new JSObject());
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                conn.setRequestProperty(key, headers.getString(key));
            }

            String bodyBase64 = call.getString("body", null);
            if (bodyBase64 != null) {
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(Base64.decode(bodyBase64, Base64.NO_WRAP));
                }
            }

            int statusCode = conn.getResponseCode();
            String statusMessage = conn.getResponseMessage();

            // Straight from the socket to disk — the response is never held
            // whole in memory here, which is what lets a full-history pack
            // through at all.
            spill = new File(dir, UUID.randomUUID().toString());
            long length;
            InputStream responseStream = statusCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (responseStream == null) {
                length = 0;
                //noinspection ResultOfMethodCallIgnored
                spill.createNewFile();
            } else {
                long contentLength = conn.getContentLengthLong();
                try (InputStream in = responseStream; OutputStream out = new FileOutputStream(spill)) {
                    length = copyStreamReportingProgress(in, out, conn.getURL().toString(), contentLength);
                }
            }

            JSObject responseHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue; // the status line itself has a null key in this map
                responseHeaders.put(entry.getKey(), String.join(", ", entry.getValue()));
            }

            JSObject ret = new JSObject();
            ret.put("url", conn.getURL().toString());
            ret.put("statusCode", statusCode);
            ret.put("statusMessage", statusMessage != null ? statusMessage : "");
            ret.put("headers", responseHeaders);
            ret.put("bodyLength", length);

            if (length <= INLINE_MAX_BYTES) {
                ret.put("body", Base64.encodeToString(readFully(spill, (int) length), Base64.NO_WRAP));
                //noinspection ResultOfMethodCallIgnored
                spill.delete();
                spill = null;
            } else {
                // The renderer now owns this file and must releaseBody() it.
                ret.put("bodyFile", spill.getAbsolutePath());
                spill = null;
            }
            call.resolve(ret);
        } catch (Exception e) {
            if (spill != null) {
                //noinspection ResultOfMethodCallIgnored
                spill.delete();
            }
            call.reject(e.getMessage(), e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Reads one slice of a spilled response body. The renderer walks the
     *  file with these rather than asking for it whole, so the largest
     *  allocation on either side of the bridge is one slice. Returns fewer
     *  bytes than asked for at the end of the file, and an empty string
     *  past it. */
    @PluginMethod
    public void readBodyChunk(PluginCall call) {
        try {
            File file = resolveSpillFile(call.getString("path"));
            long offset = call.getLong("offset", 0L);
            int length = call.getInt("length", INLINE_MAX_BYTES);
            if (offset < 0 || length <= 0) throw new IOException("Bad offset/length");

            long remaining = file.length() - offset;
            int toRead = remaining <= 0 ? 0 : (int) Math.min((long) length, remaining);

            JSObject ret = new JSObject();
            if (toRead == 0) {
                ret.put("data", "");
                ret.put("bytesRead", 0);
            } else {
                byte[] bytes = new byte[toRead];
                try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                    raf.seek(offset);
                    raf.readFully(bytes);
                }
                ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                ret.put("bytesRead", toRead);
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** Drops a spilled body once the renderer has finished with it.
     *  Deliberately succeeds when the file is already gone — the renderer
     *  calls this from a finally block, including on paths where the
     *  request itself failed and nothing was ever spilled. */
    @PluginMethod
    public void releaseBody(PluginCall call) {
        try {
            File file = resolveSpillFile(call.getString("path"));
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
