import "dotenv/config";
import express from "express";
// Patches Express so a rejected promise inside an async route handler is
// forwarded to the error middleware below instead of hanging the request
// forever. Must be imported before any router that uses async handlers.
import "express-async-errors";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { recipeRouter }     from "./routes/recipes";
import { shoppingRouter }   from "./routes/shopping";
import { syncRouter }       from "./routes/sync";
import { llmRouter }        from "./routes/llm";
import { menuRouter }       from "./routes/menus";
import { ingredientsRouter, unitsRouter, toolsRouter } from "./routes/ingredients";
import { techniquesRouter } from "./routes/techniques";
import { tagsRouter }       from "./routes/tags";
import { collectionsRouter } from "./routes/collections";
import { uploadsRouter }    from "./routes/uploads";
import { authRouter }       from "./routes/auth";
import { shareRouter }      from "./routes/share";
import { syncFolderRouter } from "./routes/sync-folder";
import { backupRouter }     from "./routes/backup";
import { pantryRouter }     from "./routes/pantry";
import { shareLinkRouter, publicRouter } from "./routes/publicShare";
import { cookLogRouter }    from "./routes/cook-log";
import { geocodeRouter }    from "./routes/geocode";
import { requireAuth }      from "./middleware/requireAuth";
import { checkOllamaHealth } from "./services/llm.parser";
import { startSyncLoop }    from "./services/mdns.service";
import { startFolderSyncLoop, SYNC_ENABLED } from "./services/folder-sync.service";
import { UPLOAD_DIR }       from "./services/uploadDir";
import pool                 from "./db/pool";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Middleware ─────────────────────────────────────────────────────────
app.use(helmet());
// CORS_ORIGIN accepts a comma-separated list — this needs to allow *every*
// distinct origin a credentialed browser-like client calls the API from,
// not just the server's own address. A browser hitting the Tailscale HTTPS
// URL sends Origin: https://<tailscale-host> (same-origin via nginx, so
// this rarely even matters there), but the Capacitor Android app's WebView
// requests come from its own fixed app origin (https://localhost by
// Capacitor's default androidScheme) regardless of which server it's
// pointed at — so that origin needs to be allowed explicitly too.
const corsOrigins = (process.env.CORS_ORIGIN ?? "*").split(",").map((o) => o.trim());
app.use(cors({
  origin: corsOrigins.includes("*") ? "*" : corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// ── Routes ─────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
// /api/sync is device-to-device (mDNS peer handshake/receive), not
// browser traffic — it carries no session cookie, so it stays outside
// the auth gate. Excluded before the blanket requireAuth below.
app.use("/api/sync", syncRouter);
// The only unauthenticated read path in the app: a recipe someone chose to
// share by link. Mounted before the gate below, like /api/auth is.
app.use("/api/public", publicRouter);
app.use("/api", requireAuth);
app.use("/api/recipes",     recipeRouter);
app.use("/api/shopping",    shoppingRouter);
app.use("/api/llm",         llmRouter);
app.use("/api/menus",       menuRouter);
app.use("/api/ingredients", ingredientsRouter);
app.use("/api/units",       unitsRouter);
app.use("/api/tools",       toolsRouter);
app.use("/api/techniques",  techniquesRouter);
app.use("/api/tags",        tagsRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/share",       shareRouter);
app.use("/api/share",       shareLinkRouter);
app.use("/api/sync-folder", syncFolderRouter);
app.use("/api/backup",      backupRouter);
app.use("/api/uploads",     uploadsRouter);
app.use("/api/cook-log",    cookLogRouter);
app.use("/api/pantry",      pantryRouter);
app.use("/api/geocode",     geocodeRouter);
app.use("/uploads",         express.static(UPLOAD_DIR));


// ── Health Check ───────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {}

  const ollama = await checkOllamaHealth();

  res.json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk,
    ollama: ollama.ok,
    ollamaModels: ollama.models,
    version: "1.1.1",
    timestamp: new Date().toISOString(),
  });
});

// ── Error Handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const isProd = process.env.NODE_ENV === "production";
  res.status(500).json({ error: isProd ? "Errore interno" : (err.message ?? "Errore interno") });
});

app.listen(PORT, () => {
  console.log(`🍳 SmartChef Backend running on :${PORT}`);
  console.log(`   DB:     ${process.env.DATABASE_URL?.replace(/:\/\/.*@/, "://***@") ?? "not set"}`);
  console.log(`   Ollama: ${process.env.OLLAMA_URL ?? "http://localhost:11434"}`);
  if (process.env.NODE_ENV === "production") {
    startSyncLoop(30_000);
    console.log("   🔄 Sync loop attivo (30s)");
  }
  if (SYNC_ENABLED) {
    startFolderSyncLoop(90_000);
    console.log(`   📁 Folder sync attivo (90s) — ${process.env.SYNC_FOLDER ?? "/app/sync"}`);
  }
});
