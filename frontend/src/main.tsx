import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./index.css";
import "./i18n";
import { isNative } from "./lib/api";

// On native Android, keep the WebView below the status bar instead of
// drawing under it — combined with viewport-fit=cover + env(safe-area-inset-*)
// this is what actually reserves space instead of letting content start
// underneath the status bar/notch. No-op on web (isNative() is false there).
if (isNative()) {
  import("@capacitor/status-bar")
    .then(({ StatusBar }) => StatusBar.setOverlaysWebView({ overlay: false }))
    .catch(() => {});
}

// Since Capacitor 4, the native shell no longer auto-forwards the hardware/
// gesture back button to WebView.goBack() — apps must handle it themselves
// or it does nothing (or exits unpredictably). BrowserRouter already pushes
// a real history entry per navigation, so history.back() correctly retraces
// in-app navigation; only exits the app once there's nowhere left to go.
if (isNative()) {
  import("@capacitor/app").then(({ App: CapacitorApp }) => {
    CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else CapacitorApp.exitApp();
    });
  }).catch(() => {});
}

// PWA service worker: web only. On native, the app shell already ships
// bundled inside the APK — no network round-trip to cache, and worse,
// Android doesn't clear a WebView's Cache Storage across a plain
// install-over-existing APK update, so a service worker registered by an
// old build would keep serving its stale precached JS after every new
// install. Force an immediate reload as soon as a new deployed *web*
// version is detected, instead of leaving the tab running stale cached JS
// until the user happens to close and reopen it.
if (!isNative()) {
  const updateSW = registerSW({
    onNeedRefresh() {
      updateSW(true);
    },
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
