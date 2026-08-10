// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: LLM Import
// Parsing ricetta + matching ingredienti + salvataggio in DB
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import { parseRecipeWithLLM, checkOllamaHealth } from "../services/llm.parser";
import { matchLLMResultToDB } from "../services/ingredient.matcher";
import { withTransaction } from "../db/pool";
import { v4 as uuidv4 } from "uuid";

export const llmRouter = Router();

// ── POST /llm/parse ────────────────────────────────────────────────────
// Step 1: Parsing + matching senza salvare (preview per l'utente)

llmRouter.post("/parse", async (req: Request, res: Response) => {
  const schema = z.object({
    input: z.string().min(1),
    inputType: z.enum(["url", "text"]),
  }).refine(d => d.inputType !== "url" || z.string().url().safeParse(d.input).success, {
    message: "input deve essere un URL valido quando inputType è 'url'",
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const llmResult = await parseRecipeWithLLM(parsed.data);
    const matched = await matchLLMResultToDB(llmResult);
    res.json({ data: matched });
  } catch (err) {
    console.error("LLM parse failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Parsing fallito" });
  }
});

// ── POST /llm/confirm ─────────────────────────────────────────────────
// Step 2: L'utente conferma (opzionalmente modificando) e salva nel DB

llmRouter.post("/confirm", async (req: Request, res: Response) => {
  const IngSchema = z.object({
    ingredientId: z.string().uuid(),
    sortOrder: z.number().int().default(0),
    quantity: z.number().positive().optional(),
    quantityText: z.string().optional(),
    unitId: z.string().uuid().optional(),
    notes: z.string().optional(),
    isOptional: z.boolean().default(false),
  });

  const schema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().optional(),
    servings: z.number().int().positive().default(4),
    prepTimeMin: z.number().int().positive().optional(),
    cookTimeMin: z.number().int().positive().optional(),
    difficulty: z.enum(["easy","medium","hard","expert"]).default("medium"),
    tags: z.array(z.string()).default([]),
    sourceUrl: z.string().url().optional(),
    ingredients: z.array(IngSchema),
    steps: z.array(z.object({
      stepNumber: z.number().int().positive(),
      title: z.string().optional(),
      description: z.string().min(1),
      durationMin: z.number().int().positive().optional(),
    })),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const recipeId = uuidv4();

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO recipes
           (id,title,description,difficulty,servings,prep_time_min,cook_time_min,
            tags,source_url,crdt_clock,sync_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','local')`,
        [recipeId,d.title,d.description,d.difficulty,d.servings,
         d.prepTimeMin,d.cookTimeMin,d.tags,d.sourceUrl]
      );

      for (const ing of d.ingredients) {
        await client.query(
          `INSERT INTO recipe_ingredients
             (id,recipe_id,sort_order,ingredient_id,quantity,quantity_text,unit_id,notes,is_optional)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv4(),recipeId,ing.sortOrder,ing.ingredientId,
           ing.quantity??null,ing.quantityText??null,ing.unitId??null,
           ing.notes??null,ing.isOptional]
        );
      }

      for (const step of d.steps) {
        await client.query(
          `INSERT INTO recipe_steps
             (id,recipe_id,step_number,title,description,duration_min)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuidv4(),recipeId,step.stepNumber,step.title??null,
           step.description,step.durationMin??null]
        );
      }
    });
  } catch (err) {
    console.error("LLM confirm failed:", err);
    return res.status(500).json({ error: "Impossibile salvare la ricetta" });
  }

  res.status(201).json({ data: { id: recipeId, title: d.title } });
});

// ── GET /llm/health ────────────────────────────────────────────────────

llmRouter.get("/health", async (_req: Request, res: Response) => {
  const status = await checkOllamaHealth();
  res.json({ data: status });
});
