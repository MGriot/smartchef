import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { backend } from "./backendClient.js";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const RecipeIngredientShape = z.object({
  sortOrder: z.number().int().default(0),
  ingredientId: z.string().uuid().optional().describe("UUID of an existing ingredient (mutually exclusive with subRecipeId)"),
  subRecipeId: z.string().uuid().optional().describe("UUID of another recipe used as a nested sub-recipe (mutually exclusive with ingredientId)"),
  quantity: z.number().positive().optional(),
  quantityText: z.string().optional().describe("Vague quantity like 'to taste' when no numeric amount applies"),
  unitId: z.string().uuid().optional(),
  notes: z.string().optional(),
  isOptional: z.boolean().default(false),
});

const RecipeStepShape = z.object({
  stepNumber: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().min(1),
  durationMin: z.number().int().positive().optional(),
  toolIds: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
});

export function registerTools(server: McpServer) {
  server.tool(
    "list_recipes",
    "Search and list recipes in the SmartChef library. Returns id, title, difficulty, servings, tags and ingredient count for each match.",
    {
      q: z.string().optional().describe("Free-text search over the recipe title"),
      tag: z.string().optional(),
      difficulty: z.enum(["easy", "medium", "hard", "expert"]).optional(),
      component: z.boolean().optional().describe("Filter to only sub-recipe components (Matrioska building blocks) when true"),
      lang: z.string().optional().describe("Language code (e.g. 'en') to prefer translated titles/descriptions when available"),
    },
    async ({ q, tag, difficulty, component, lang }) => {
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (tag) params.set("tag", tag);
        if (difficulty) params.set("difficulty", difficulty);
        if (component !== undefined) params.set("component", String(component));
        if (lang) params.set("lang", lang);
        const qs = params.toString();
        const data = await backend.get(`/recipes${qs ? `?${qs}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "get_recipe",
    "Get the full detail of a single recipe by id, including its ingredients, steps and required tools.",
    {
      id: z.string().uuid(),
      lang: z.string().optional().describe("Language code to prefer translated content when available"),
    },
    async ({ id, lang }) => {
      try {
        const data = await backend.get(`/recipes/${id}${lang ? `?lang=${lang}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "scale_recipe_portions",
    "Compute the ingredient list for a recipe scaled to a target number of servings. Recursively resolves nested sub-recipes (the 'Matrioska' engine) and aggregates duplicate ingredients.",
    {
      id: z.string().uuid(),
      servings: z.number().int().positive().max(1000),
    },
    async ({ id, servings }) => {
      try {
        const data = await backend.get(`/recipes/${id}/portions?servings=${servings}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "create_recipe",
    "Create a new recipe in the SmartChef library, including its ingredient list, method steps and required tools. Ingredients may reference either an existing ingredient by id or another recipe (as a nested sub-recipe).",
    {
      title: z.string().min(1).max(200),
      description: z.string().optional(),
      difficulty: z.enum(["easy", "medium", "hard", "expert"]).default("medium"),
      servings: z.number().int().positive().default(4),
      prepTimeMin: z.number().int().positive().optional(),
      cookTimeMin: z.number().int().positive().optional(),
      restTimeMin: z.number().int().positive().optional(),
      tags: z.array(z.string()).default([]),
      coverImageUrl: z.string().nullable().optional(),
      sourceUrl: z.string().nullable().optional(),
      isComponent: z.boolean().default(false).describe("Mark true if this recipe is only meant to be used as a sub-recipe component of other recipes"),
      ingredients: z.array(RecipeIngredientShape).default([]),
      steps: z.array(RecipeStepShape).default([]),
      toolIds: z.array(z.string().uuid()).default([]),
    },
    async (input) => {
      try {
        const data = await backend.post("/recipes", input);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_ingredients",
    "List ingredients in the SmartChef pantry library, optionally filtered by a search query.",
    {
      q: z.string().optional(),
      lang: z.string().optional().describe("Language code to prefer translated names when available"),
    },
    async ({ q, lang }) => {
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (lang) params.set("lang", lang);
        const qs = params.toString();
        const data = await backend.get(`/ingredients${qs ? `?${qs}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_ingredient_categories",
    "List the ingredient categories used to organize the SmartChef pantry library.",
    { lang: z.string().optional() },
    async ({ lang }) => {
      try {
        const data = await backend.get(`/ingredients/categories${lang ? `?lang=${lang}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_units",
    "List measurement units (weight, volume, count) available for recipe ingredients, with their conversion factors.",
    { lang: z.string().optional() },
    async ({ lang }) => {
      try {
        const data = await backend.get(`/units${lang ? `?lang=${lang}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_tools",
    "List kitchen tools/equipment that recipes can require.",
    { lang: z.string().optional() },
    async ({ lang }) => {
      try {
        const data = await backend.get(`/tools${lang ? `?lang=${lang}` : ""}`);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
