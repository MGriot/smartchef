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
        // woff2 is in here so the shell renders with its own type and icons
        // on a first offline load rather than falling back to system faces.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // ...but not the heavy on-demand chunks. Precaching downloads
        // everything listed here at install time, and these four are only
        // reached by a specific action: OCR on an imported photo (the
        // tesseract core and its worker), reading a PDF, drawing the world
        // map, and talking to a git remote. Together they were 5.5 MB of a
        // 6.8 MB install for features most sessions never touch. The
        // runtime rule below still caches each one the first time it is
        // actually used, so once you have used it, it works offline.
        globIgnores: [
          "**/tesseract-core*",
          "**/worker.min-*",
          "**/pdf-*.js",
          "**/pdf.worker*",
          "**/worldGeo-*",
          "**/gitRemoteTransport-*",
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/assets/"),
            handler: "CacheFirst",
            options: {
              cacheName: "smartchef-lazy-chunks",
              // Content-hashed filenames, so a cached entry is never stale
              // — only ever unreferenced, which cleanupOutdatedCaches and
              // this ceiling take care of between them.
              expiration: { maxEntries: 60 },
            },
          },
        ],
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // Default 2 MiB limit no longer fits the main bundle now that the
        // Capacitor native plugins (SQLite, network, etc.) are included —
        // they're only ever exercised on native builds, but still ship in
        // the one shared JS bundle the web build also serves.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  base: "/",
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/uploads": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
