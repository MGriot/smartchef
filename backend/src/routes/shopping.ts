import { Router, Request, Response } from "express";
import { z } from "zod";
import { query } from "../db/pool";
import { generateShoppingList, exportShoppingListMarkdown, loadShoppingList } from "../services/shopping.service";

export const shoppingRouter = Router();

// GET /shopping — elenco delle liste generate finora
shoppingRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT sl.*, COUNT(sli.id) AS item_count
     FROM shopping_lists sl
     LEFT JOIN shopping_list_items sli ON sli.shopping_list_id = sl.id
     GROUP BY sl.id
     ORDER BY sl.created_at DESC`
  );
  res.json({ data: rows });
});

// POST /shopping/generate — Genera lista da un menù salvato o da un
// carrello ad-hoc di ricette (senza bisogno di salvare un menù)
shoppingRouter.post("/generate", async (req: Request, res: Response) => {
  const schema = z.object({
    listName: z.string().min(1).default("Shopping List"),
    menuId: z.string().uuid().optional(),
    recipes: z.array(z.object({
      recipeId: z.string().uuid(),
      servings: z.number().int().positive(),
    })).optional(),
  }).refine(d => d.menuId || (d.recipes && d.recipes.length > 0), {
    message: "Serve un menuId oppure una lista di ricette",
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { listName, menuId, recipes } = parsed.data;

  try {
    const list = await generateShoppingList(
      menuId ? { menuId } : { recipes: recipes! },
      listName
    );
    res.status(201).json({ data: list });
  } catch (err) {
    console.error("Shopping list generation failed:", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "Generazione fallita" });
  }
});

// GET /shopping/:id — dettaglio lista con item
shoppingRouter.get("/:id", async (req: Request, res: Response) => {
  const list = await loadShoppingList(req.params.id);
  if (!list) return res.status(404).json({ error: "Lista non trovata" });
  res.json({ data: list });
});

// GET /shopping/:id/export — Export Markdown
shoppingRouter.get("/:id/export", async (req: Request, res: Response) => {
  const list = await loadShoppingList(req.params.id);
  if (!list) return res.status(404).json({ error: "Lista non trovata" });

  const md = exportShoppingListMarkdown(list);

  res.setHeader("Content-Type", "text/markdown");
  res.setHeader("Content-Disposition", `attachment; filename="lista-spesa.md"`);
  res.send(md);
});

// PATCH /shopping/:listId/items/:itemId/check
shoppingRouter.patch("/:listId/items/:itemId/check", async (req: Request, res: Response) => {
  const { checked } = req.body;
  await query(
    "UPDATE shopping_list_items SET is_checked=$1 WHERE id=$2 AND shopping_list_id=$3",
    [!!checked, req.params.itemId, req.params.listId]
  );
  res.json({ ok: true });
});

// DELETE /shopping/:id
shoppingRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("DELETE FROM shopping_lists WHERE id=$1", [req.params.id]);
  res.status(204).send();
});
