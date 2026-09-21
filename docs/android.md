# The Android app

Installing the APK, reaching a server from outside the house with
Tailscale, and building the app yourself.

> Part of the [SmartChef documentation](../README.md#documentation).

---

## 📱 Mobile App (Android) & Remote Access via Tailscale

SmartChef is already an installable PWA, but for a native Android app with a real offline cache, a [Capacitor](https://capacitorjs.com) wrapper (`frontend/android/`) was added, reusing the entire existing React frontend. For it to work — both at home and away — the backend needs a reachable HTTPS address, provided by [Tailscale](https://tailscale.com) instead of a traditional reverse proxy/public domain: no router ports to open, one stable address that's identical on LAN and remote.

### 1. Install Tailscale on both devices

- **On the PC acting as server:** `winget install Tailscale.Tailscale`, then `tailscale up` (opens a login URL to complete in the browser).
- **On the phone:** install the Tailscale app from the Play Store, sign in with the same account.
- **Enable HTTPS certificates** (one-time, per tailnet) in the admin console: <https://login.tailscale.com/admin/dns> → "HTTPS Certificates" section → Enable.

### 2. Expose the app over HTTPS

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8888
```

Makes the app reachable at `https://<machine-name>.<your-tailnet>.ts.net` with a real certificate (Let's Encrypt, auto-renewed by Tailscale) — no need to configure Caddy/nginx for certs. Verify with `tailscale serve status` and `tailscale status` (shows the exact machine name and whether the phone is already connected to the same tailnet).

### 3. Configure session cookies and CORS

The native app runs on a fixed origin (`https://localhost`, Capacitor's default `androidScheme`) different from the backend's — unlike a regular browser, which goes through the same domain via the frontend's nginx proxy. This needs explicit config in `docker/.env` (copy from `docker/.env.example`):

```bash
COOKIE_SAME_SITE=none
COOKIE_SECURE=true
CORS_ORIGIN=https://<machine-name>.<your-tailnet>.ts.net,https://localhost
```

`CORS_ORIGIN` accepts a comma-separated list — it must include **both** the Tailscale address (for browser access) **and** `https://localhost` (the Android WebView's fixed origin, independent of which server the app is configured to talk to). Then:

```bash
podman compose up -d --build backend
podman restart smartchef_frontend   # otherwise nginx keeps caching the backend's old IP
```

### 4. Build the Android app

```bash
cd frontend
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is generated at `frontend/android/app/build/outputs/apk/debug/app-debug.apk`. Install it on the phone (via `adb install app-debug.apk`, or transfer the file and open it directly — requires allowing "install from unknown sources").

### 5. Connect the app to the server

On first launch the app shows a "Connect to your SmartChef server" screen — enter the Tailscale address (`https://<machine-name>.<your-tailnet>.ts.net`). The app checks `/health` before saving the address; if that check fails, confirm Tailscale is connected on the phone and steps 2–3 above are complete.

### Offline mode

Once logged in, the phone keeps a local cache (SQLite) of the whole library (recipes, ingredients, tags, tools, collections) and a queue of changes made without connectivity (creating/editing recipes and ingredients, ratings, deletions, logging a cook), automatically replayed against the backend as soon as the connection returns.

---
