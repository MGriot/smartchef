// ════════════════════════════════════════════════════════════════════════
// SmartChef — Public recipe links
//
// Two halves that must not be confused:
//   - `shareLinkRouter` is mounted UNDER the auth gate. Creating and
//     revoking a link is an owner action.
//   - `publicRouter` is mounted OUTSIDE it, and is the only unauthenticated
//     read path in the app.
//
// ── The projection is an allowlist, on purpose ──────────────────────────
// It builds the public response field by field rather than taking the
// internal recipe and deleting a few keys. The subtractive version looks
// tidier and leaks every field added afterwards — the next column someone
// adds to `recipes` would silently become public. Anything not named below
// is not published, including who created it, private notes, ratings and
// the cook log.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { query, queryOne } from "../db/pool";

export const shareLinkRouter = Router();
export const publicRouter = Router();

/** 32 bytes of crypto randomness, base64url. The token IS the credential,
 *  so it must be unguessable and must never be derived from the recipe id
 *  or a counter. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// ── Owner side (authenticated) ──────────────────────────────────────────

// GET /share/links/:recipeId — the link for this recipe, if any.
shareLinkRouter.get("/links/:recipeId", async (req: Request, res: Response) => {
  const row = await queryOne(
    `SELECT token, created_at AS "createdAt", expires_at AS "expiresAt",
            view_count AS "viewCount", last_seen_at AS "lastSeenAt"
       FROM recipe_share_links
      WHERE recipe_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [req.params.recipeId]
  );
  res.json({ data: row ?? null });
});

// POST /share/links/:recipeId — create (or replace) the link.
shareLinkRouter.post("/links/:recipeId", async (req: Request, res: Response) => {
  const parsed = z.object({ expiresInDays: z.number().int().positive().max(365).optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const recipe = await queryOne<{ id: string }>(
    "SELECT id FROM recipes WHERE id=$1 AND sync_status != 'deleted'",
    [req.params.recipeId]
  );
  if (!recipe) return res.status(404).json({ error: "Recipe not found" });

  // One live link per recipe: re-sharing mints a fresh token and retires
  // the old one, so "share again" is also "revoke the link I sent before".
  await query("DELETE FROM recipe_share_links WHERE recipe_id=$1", [req.params.recipeId]);

  const token = newToken();
  const days = parsed.data.expiresInDays;
  await query(
    `INSERT INTO recipe_share_links (token, recipe_id, created_by, expires_at)
     VALUES ($1, $2, $3, ${days ? `now() + interval '${days} days'` : "NULL"})`,
    [token, req.params.recipeId, req.userId ?? null]
  );

  res.status(201).json({ data: { token } });
});

// DELETE /share/links/:recipeId — revoke.
shareLinkRouter.delete("/links/:recipeId", async (req: Request, res: Response) => {
  await query("DELETE FROM recipe_share_links WHERE recipe_id=$1", [req.params.recipeId]);
  res.json({ success: true });
});

// ── Public side (no authentication) ─────────────────────────────────────

interface PublicRecipeRow {
  id: string;
  title: string;
  description: string | null;
  cover_image_url: string | null;
  servings: number;
  prep_time_min: number | null;
  cook_time_min: number | null;
  rest_time_min: number | null;
  difficulty: string | null;
  storage_instructions: string | null;
  tips: string | null;
  language_code: string | null;
}

async function loadSharedRecipe(token: string) {
  const link = await queryOne<{ recipe_id: string }>(
    `SELECT recipe_id FROM recipe_share_links
      WHERE token = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [token]
  );
  if (!link) return null;

  const recipe = await queryOne<PublicRecipeRow>(
    `SELECT id, title, description, cover_image_url, servings,
            prep_time_min, cook_time_min, rest_time_min, difficulty,
            storage_instructions, tips, language_code
       FROM recipes
      WHERE id = $1 AND sync_status != 'deleted'`,
    [link.recipe_id]
  );
  if (!recipe) return null;

  const ingredients = await query<{
    sort_order: number; name: string | null; sub_recipe_title: string | null;
    quantity: string | null; quantity_text: string | null; unit_symbol: string | null;
    notes: string | null; group_name: string | null;
  }>(
    `SELECT ri.sort_order, i.name, sr.title AS sub_recipe_title,
            ri.quantity, ri.quantity_text, u.symbol AS unit_symbol,
            ri.notes, ri.group_name
       FROM recipe_ingredients ri
       LEFT JOIN ingredients i ON i.id = ri.ingredient_id
       LEFT JOIN recipes sr    ON sr.id = ri.sub_recipe_id
       LEFT JOIN units u       ON u.id = ri.unit_id
      WHERE ri.recipe_id = $1
      ORDER BY ri.sort_order`,
    [link.recipe_id]
  );

  const steps = await query<{ step_number: number; title: string | null; description: string; duration_min: number | null }>(
    `SELECT step_number, title, description, duration_min
       FROM recipe_steps WHERE recipe_id = $1 ORDER BY step_number`,
    [link.recipe_id]
  );

  return {
    title: recipe.title,
    description: recipe.description,
    coverImageUrl: recipe.cover_image_url,
    servings: recipe.servings,
    prepTimeMin: recipe.prep_time_min,
    cookTimeMin: recipe.cook_time_min,
    restTimeMin: recipe.rest_time_min,
    difficulty: recipe.difficulty,
    storageInstructions: recipe.storage_instructions,
    tips: recipe.tips,
    languageCode: recipe.language_code,
    ingredients: ingredients.map((i) => ({
      sortOrder: i.sort_order,
      name: i.name ?? i.sub_recipe_title ?? "",
      // Steps reference ingredients by index with {{ing:N}} tokens; those
      // are stripped from the public step text below rather than exposing
      // the internal token format.
      quantity: i.quantity != null ? Number(i.quantity) : null,
      quantityText: i.quantity_text,
      unitSymbol: i.unit_symbol,
      notes: i.notes,
      groupName: i.group_name,
    })),
    steps: steps.map((s) => ({
      stepNumber: s.step_number,
      title: s.title,
      description: stripInlineTokens(s.description),
      durationMin: s.duration_min,
    })),
  };
}

/** Step text carries {{ing:0}} / {{tool:uuid}} / {{tech:uuid}} references
 *  that only mean something inside the app. A public reader gets the plain
 *  sentence instead of raw tokens or leaked internal ids. */
function stripInlineTokens(text: string): string {
  return text.replace(/\{\{(?:ing|tool|tech):[^}|]+(?:\|([^}]*))?\}\}/g, (_m, params) => params ?? "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// GET /public/recipes/:token
publicRouter.get("/recipes/:token", async (req: Request, res: Response) => {
  const recipe = await loadSharedRecipe(req.params.token);
  if (!recipe) return res.status(404).json({ error: "This link is no longer available." });

  // Best-effort view counter — never fail the read over it.
  query(
    "UPDATE recipe_share_links SET view_count = view_count + 1, last_seen_at = now() WHERE token = $1",
    [req.params.token]
  ).catch(() => {});

  res.json({ data: recipe });
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// GET /public/r/:token — a real HTML page.
//
// Needed because a shared link is pasted into a chat, and a chat previews
// it by fetching the URL as a document: a JSON endpoint yields no title, no
// image and no description. This is deliberately server-rendered and
// self-contained rather than deep-linking into the SPA, so it works with no
// JavaScript and renders identically to a crawler and a person.
publicRouter.get("/r/:token", async (req: Request, res: Response) => {
  const recipe = await loadSharedRecipe(req.params.token);
  if (!recipe) {
    return res.status(404).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Link unavailable</title>
       <body style="font-family:system-ui;padding:3rem;max-width:34rem;margin:0 auto">
       <h1>This link is no longer available</h1>
       <p>It may have been revoked by whoever shared it, or it may have expired.</p></body>`
    );
  }

  const title = escapeHtml(recipe.title);
  const description = escapeHtml(recipe.description ?? `A recipe for ${recipe.servings} servings.`);
  const image = recipe.coverImageUrl && /^https?:\/\//.test(recipe.coverImageUrl)
    ? escapeHtml(recipe.coverImageUrl)
    : null;

  const ingredientList = recipe.ingredients
    .map((i) => {
      const amount = [i.quantity ?? i.quantityText, i.unitSymbol].filter(Boolean).join(" ");
      const note = i.notes ? ` <em>${escapeHtml(i.notes)}</em>` : "";
      return `<li><strong>${escapeHtml(String(amount))}</strong> ${escapeHtml(i.name)}${note}</li>`;
    })
    .join("");

  const stepList = recipe.steps
    .map((s) => `<li>${s.title ? `<strong>${escapeHtml(s.title)}</strong><br>` : ""}${escapeHtml(s.description)}</li>`)
    .join("");

  res.type("html").send(`<!doctype html>
<html lang="${escapeHtml(recipe.languageCode ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
${image ? `<meta property="og:image" content="${image}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="robots" content="noindex">
<style>
  :root{color-scheme:light dark;--ink:#14180f;--soft:#5a6157;--bg:#f7f6f0;--card:#fff;--rule:#e2e2d8;--accent:#006c49}
  @media(prefers-color-scheme:dark){:root{--ink:#e6e7e1;--soft:#a9b1a6;--bg:#101210;--card:#191c18;--rule:#2c312a;--accent:#4ede9f}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
  img{width:100%;border-radius:14px;margin-bottom:1.5rem}
  h1{font-size:2.1rem;line-height:1.15;margin:0 0 .5rem}
  .meta{color:var(--soft);font-size:.9rem;margin:0 0 2rem}
  h2{font-size:1.1rem;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:2.5rem 0 .75rem}
  ul,ol{padding-left:1.25rem;margin:0}
  li{margin:.45rem 0}
  em{color:var(--soft);font-style:normal;font-size:.9em}
  footer{margin-top:4rem;padding-top:1.25rem;border-top:1px solid var(--rule);color:var(--soft);font-size:.82rem}
</style>
</head>
<body><main>
${image ? `<img src="${image}" alt="">` : ""}
<h1>${title}</h1>
<p class="meta">${recipe.servings} servings${recipe.prepTimeMin ? ` &middot; ${recipe.prepTimeMin} min prep` : ""}${recipe.cookTimeMin ? ` &middot; ${recipe.cookTimeMin} min cooking` : ""}</p>
${recipe.description ? `<p>${escapeHtml(recipe.description)}</p>` : ""}
${ingredientList ? `<h2>Ingredients</h2><ul>${ingredientList}</ul>` : ""}
${stepList ? `<h2>Method</h2><ol>${stepList}</ol>` : ""}
${recipe.tips ? `<h2>Tips</h2><p>${escapeHtml(recipe.tips)}</p>` : ""}
${recipe.storageInstructions ? `<h2>Storage</h2><p>${escapeHtml(recipe.storageInstructions)}</p>` : ""}
<footer>Shared from a private SmartChef library. Only this recipe is visible.</footer>
</main></body></html>`);
});
