import "dotenv/config";
import express from "express";
// Patches Express so a rejected promise inside an async route handler is
// forwarded to the error middleware below instead of hanging the request
// forever. Must be imported before any router that uses async handlers.
import "express-async-errors";
import cors from "cors";
import helmet from "helmet";
import { recipeRouter }     from "./routes/recipes";
import { shoppingRouter }   from "./routes/shopping";
import { syncRouter }       from "./routes/sync";
import { llmRouter }        from "./routes/llm";
import { menuRouter }       from "./routes/menus";
import { ingredientsRouter, unitsRouter, toolsRouter } from "./routes/ingredients";
import { techniquesRouter } from "./routes/techniques";
import { uploadsRouter }    from "./routes/uploads";
import { checkOllamaHealth } from "./services/llm.parser";
import { startSyncLoop }    from "./services/mdns.service";
import { UPLOAD_DIR }       from "./services/uploadDir";
import pool                 from "./db/pool";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Middleware ─────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
app.use(express.json({ limit: "5mb" }));

// ── Routes ─────────────────────────────────────────────────────────────
app.use("/api/recipes",     recipeRouter);
app.use("/api/shopping",    shoppingRouter);
app.use("/api/sync",        syncRouter);
app.use("/api/llm",         llmRouter);
app.use("/api/menus",       menuRouter);
app.use("/api/ingredients", ingredientsRouter);
app.use("/api/units",       unitsRouter);
app.use("/api/tools",       toolsRouter);
app.use("/api/techniques",  techniquesRouter);
app.use("/api/uploads",     uploadsRouter);
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
    version: "1.0.0",
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
});
