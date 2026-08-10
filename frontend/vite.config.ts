import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // We call registerSW() ourselves in main.tsx so a detected update
      // forces an immediate reload instead of silently waiting for the next
      // natural navigation — avoids users getting stuck on a stale cached
      // bundle after a deploy.
      injectRegister: false,
      // App-shell caching only (installable web app) — no API response
      // caching / offline data. Recipe data always comes fresh from the
      // backend; this just makes repeat loads instant and the app
      // installable on desktop/mobile.
      manifest: false, // we ship a static manifest.webmanifest in public/
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  base: "/",
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
