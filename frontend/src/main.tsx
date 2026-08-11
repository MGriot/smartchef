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

// Force an immediate reload as soon as a new deployed version is detected,
// instead of leaving the tab running stale cached JS until the user happens
// to close and reopen it.
const updateSW = registerSW({
  onNeedRefresh() {
    updateSW(true);
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
