package com.smartchef.app;

import android.util.Base64;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

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
// Whole-request/whole-response, not streamed — Capacitor's plugin bridge
// is a JSON channel (see SafMirrorPlugin.java's own header for the same
// constraint on file I/O), so bodies cross as base64 like everything else
// here. Fine for this use case: even a sizeable git push/fetch payload for
// a personal recipe library is nowhere near the size where buffering the
// whole thing in memory would actually matter.
// ════════════════════════════════════════════════════════════════════════

@CapacitorPlugin(name = "GitHttp")
public class GitHttpPlugin extends Plugin {

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
    public void request(PluginCall call) {
        HttpURLConnection conn = null;
        try {
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

            InputStream responseStream = statusCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] responseBytes = responseStream != null ? readAllBytes(responseStream) : new byte[0];

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
            ret.put("body", Base64.encodeToString(responseBytes, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
