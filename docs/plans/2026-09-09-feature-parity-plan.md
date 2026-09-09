# Feature-parity programme — plan

**Trigger**: the 2026-09-09 competitive read against Mealie, RecipeSage, KitchenOwl and Cooklang. Eleven capabilities were identified as missing or partial. This plan sequences all eleven, grounded in what the code already contains — several are much cheaper than the comparison implied, and one is architecturally impossible in half the product and needs its scope stated before it is built, not after.

**Scale, stated honestly**: this is a multi-week programme, not a session. It is ordered so that value lands early and nothing later depends on anything unbuilt. Progress is tracked in `TODO.md`; each item is done only when it works in **both** runtime modes, has tests, and is translated into all four locales.

---

## Cross-cutting constraints

These apply to every item below and are not repeated in each one.

### 1. Two runtimes, always

Every feature exists twice: server mode (Express + Postgres, `backend/src/routes/*`) and standalone mode (SQLite + `frontend/src/services/*.local.ts`, dispatched by `services/localRouter.ts`).

`localRouter.ts` gates on a hardcoded allowlist. **A namespace missing from it does not error — it falls through to an HTTP call against a server that is not configured, `apiFetch` throws "No server configured", and the page's `catch` swallows it into `console.error`.** The result is a dead button with no visible failure. This has now happened four times (`share/export`, `shopping`, `menus`, `collections`+`cook-log`). Every new namespace in this plan gets a localRouter entry and an integration test asserting `dispatchLocal(...)` does not return `null`, in the same commit as the feature.

### 2. Electron is Chromium 114

`frontend/electron/package.json` pins electron ^25.8.4. Anything newer than Chromium 114 — `field-sizing`, recent `:has()` behaviour, newer View Transitions — verifies fine in the dev browser and is **inert in the desktop build**, which is where the screenshots come from. Prefer JS where a modern CSS property is tempting.

### 3. Locale parity is enforced

`src/i18n/locales.test.ts` fails the build if `en/it/fr/es` drift. Every user-visible string added here lands in all four.

### 4. Test shape

Local services get integration tests against real SQLite via `node:sqlite` (pattern: `services/planner-shopping.local.integration.test.ts`). Parsers get unit tests with real fixture files, not hand-written approximations of them.

---

## Phase 1 — Already paid for

Both items are surfacing data the schema carries and the UI discards. Highest value per hour in the entire plan.

### 1.1 Shopping list grouped by aisle

**What exists**: `ingredient_categories` has `sort_order`, `icon` and `color`. `shopping_list_items` joins `ingredients` already. Both shopping services then discard the category and group by **first letter** (`backend/src/services/shopping.service.ts:242`, `frontend/src/services/shopping.local.ts`'s `exportShoppingListMarkdown`, and the grouped view in `pages/ShoppingList.tsx`).

**Build**: add `category_id`, `category_name`, `category_color`, `category_icon`, `category_sort_order` to the item projection in both services. Group by category ordered by `sort_order` then name, with an "Uncategorised" bucket last. Markdown export follows the same grouping. Add a drag-to-reorder on the Library's category list so the aisle order is set once and reused.

**Risk**: none material. The A–Z grouping has no dependents.

### 1.2 Unit, temperature and tin-size converter

**What exists**: `units.unit_type`, `units.to_base_factor`, `units.base_unit_symbol`, `units.system` (`metric`/`imperial`/`custom`). The nutrition service already converts weight to grams with them.

**Build**: `lib/unitConvert.ts` — pure, unit-tested, no I/O: convert a quantity between two units of the same `unit_type`; pick the best display unit for a magnitude (1200 g → 1.2 kg); metric ↔ imperial toggle on the recipe page that rewrites the ingredient column without touching stored data. Temperature is a separate affine conversion (°C/°F/gas mark) and does **not** belong in `to_base_factor` — a dedicated function. Tin sizes are a geometry helper (round ↔ square, diameter change → scale factor) with its own table of common sizes.

**Risk**: the display-unit chooser must never rewrite a `quantityText` ("a pinch", "q.b.") — those carry no number.

---

## Phase 2 — Getting recipes in

The largest block, and the one that decides whether the product is adoptable.

### 2.1 Structured-data URL import (the biggest single gap)

**What exists**: `backend/src/services/llm.parser.ts:125`'s `fetchUrlContent()` fetches the page, strips every tag with regexes, truncates to **6 000 characters**, and hands the remainder to the LLM. On CPU-only inference this is minutes per import, and anything past the truncation is silently lost.

**Build**: a `services/recipeScraper.ts` that runs **before** the model:
1. Parse `<script type="application/ld+json">`, resolve `@graph` and arrays, find a node with `@type: Recipe` (or an array containing it).
2. Map `name`, `description`, `recipeYield`, `prepTime`/`cookTime`/`totalTime` (ISO-8601 durations), `recipeIngredient[]`, `recipeInstructions[]` (string, `HowToStep`, or `HowToSection` with nested steps), `recipeCategory`, `recipeCuisine`, `keywords`, `image`, `nutrition`.
3. Fall back to microdata/RDFa (`itemprop="recipeIngredient"`) when there is no JSON-LD.
4. Return `null` when neither is present — and only then call the LLM, on the existing path, unchanged.

Ingredient lines from schema.org are free text ("200 g plain flour, sifted"); reuse the existing template parser's `parseIngredientLine()` rather than writing a second one.

**Where**: the scraper is pure (HTML string in, draft out) so it lives in `shared/` or is duplicated deliberately — it must run in **both** the backend URL import and standalone mode, where there is no backend to fetch through. Standalone already proxies outbound HTTP for geocoding via `electronGeocode()` / `androidGeocode()`; the same bridge fetches the page.

**Payoff**: import becomes near-instant and exact on most sites, with no inference cost and no truncation. The LLM stays for blogs and prose.

**Test**: real saved HTML fixtures from several major recipe sites, asserting field-by-field extraction — not a synthetic JSON-LD blob, which would prove nothing about real pages.

### 2.2 Migration importers

**What exists**: `services/backup.local.ts`'s `importSnapshot()` and the server's `mergeSnapshot()` — a tested, idempotent, id-matched merge. These are adapters onto it, not a new pipeline.

**Build**, in descending order of user base:
| Format | Shape | Notes |
|---|---|---|
| Paprika 3 | `.paprikarecipes` = zip of per-recipe gzipped JSON | Most requested; images are base64 in the JSON |
| Mealie | JSON/zip export | Easiest — closest data model to ours |
| RecipeSage | JSON-LD / CSV | Also unlocks anything RecipeSage itself can read |
| CopyMeThat | HTML export | Scrape with the same JSON-LD path as 2.1 where present |
| Mela | `.melarecipes` = zip of JSON | Small format, quick once the zip plumbing exists |
| Nextcloud Cookbook | folder of `recipe.json` (schema.org) | Free once 2.1's mapper exists — same shape |
| Crouton | `.crumb` JSON | Small |

Each adapter is `bytes → Snapshot`, so all seven share one UI, one merge, one set of conflict semantics. Ship Paprika + Mealie first and let the rest follow the same seam.

**Risk**: unit and ingredient names arrive as free text and will create duplicates against an existing library. Route every adapter through the existing fuzzy matcher (`lib/fuzzyMatch.ts`, `services/matchSuggestions.ts`) and reuse the Import screen's existing review step rather than writing blind.

### 2.3 Photo, PDF and handwriting

**Build**:
- **PDF**: `pdf.js` text layer → the template/LLM path. Text-based PDFs need no OCR at all and are the common case for a printed recipe page.
- **Photo / handwriting**: `tesseract.js` in the browser. This is the right choice for this product specifically — it keeps the offline-first, nothing-leaves-your-machine stance that Mealie's OpenAI-backed OCR gives up. Language data is downloaded per language and cached.
- Feed OCR output into the existing LLM path, since raw OCR text is exactly the freeform prose that path is for.

**Risk**: tesseract.js is a multi-MB WASM payload. It must be a **dynamic import**, loaded only when someone actually picks a photo, or every app start pays for it. Accuracy on handwriting is genuinely mediocre — the review step is mandatory, and the UI should say so rather than implying a clean read.

---

## Phase 3 — At the stove

### 3.1 Cook mode

**What exists**: steps already carry `description`, `durationMin`, `toolIds`, `techniqueIds`, per-step images, and inline ingredient references with live-scaled quantities. All the data is modelled; none of it is presented for cooking.

**Build**: a full-screen route (`/recipe/:id/cook`) — one step at a time or a continuous column, ingredients for the current step beside it, tap to tick a step off, progress preserved if the screen is left, large type, generous touch targets.

**Wake lock**: `navigator.wakeLock` is Chromium 84+, so it works in Electron 114 and on Android. Guard behind a capability check and re-acquire on `visibilitychange` — the lock is dropped whenever the tab is hidden and does not come back on its own.

### 3.2 Step timers

Built inside cook mode, not beside it. `durationMin` becomes a startable countdown; multiple timers run at once (a sauce and a roast); each is labelled with its step. Fires a notification via the Capacitor local-notifications plugin on native and a sound plus title flash on web. Timer state survives navigation within the app.

---

## Phase 4 — Planning and inventory

### 4.1 Drag-and-drop planner

**Finding**: `react-beautiful-dnd` is in `frontend/package.json` and is **imported nowhere in the codebase**. It is also deprecated upstream (unmaintained since 2024) and does not support React 18 StrictMode cleanly.

**Decision**: do not build on it. Either `@hello-pangea/dnd` (its maintained fork, near drop-in) or `@dnd-kit/core`. Remove the dead dependency either way.

**Build**: the week grid becomes a drop target per day/meal slot; recipes drag from a side rail; existing entries drag between slots. Keep the current form-based add as the keyboard-accessible path — drag-and-drop alone is not accessible, and this is the screen most likely to be used one-handed.

### 4.2 Pantry

**What exists**: `POST /api/recipes/filter-by-pantry` — a deliberate stub with a **frozen, validated request contract** (`ingredients[]` of `{ingredientId, quantity?, unit?}` plus `minMatchRatio`) returning 501. The contract was designed for this; honour it exactly rather than inventing a new shape.

**Build**: a `pantry_items` table (ingredient, quantity, unit, optional expiry), a Library-adjacent screen to manage it, "add to pantry" from a shopping list item that has been ticked off, and finally the real implementation of `filter-by-pantry` — resolve each recipe through the matrioska engine, compare against pantry stock with unit conversion from 1.2, and rank by match ratio. Then a "what can I cook right now?" entry point on the Gallery.

**Note**: KitchenOwl is the only competitor with this, and it is their core. Doing it well is a genuine differentiator on top of the sub-recipe engine — no one else can answer "can I make this?" through nested recipes.

---

## Phase 5 — Reach

### 5.1 Public share links — scope must be decided before building

**This cannot work in standalone mode.** A public URL requires a server that is running and reachable; standalone mode's entire premise is that there is no server. A device-only library has nothing to serve a link from.

Options, in order of preference:
- **(a) Server mode only.** Build it properly there; in standalone the button explains that sharing a link needs a server and offers the existing file export. Honest, cheap, no new infrastructure.
- **(b) Export to a static file** the user places anywhere they already host things. Fits the self-hosted stance; more steps for the user.
- **(c) A hosted relay.** Rejected — it contradicts the product's central promise and creates an operational burden.

**Recommendation: (a).** Build: `share_links` table (token, recipe id, created, optional expiry, optional revoke), an unauthenticated `GET /api/public/recipes/:token` returning a read-only projection (no owner, no private notes), a minimal server-rendered page so links preview correctly when pasted into a chat, and revocation in the recipe menu.

**Security**: tokens are unguessable (≥128 bits, `crypto.randomBytes`), never sequential; the public projection is an explicit allowlist of fields, never the internal recipe object minus a few keys — that pattern leaks every field added later.

### 5.2 Browser clipper extension

A separate deliverable with its own build, manifest and store review, not a change to this repo's apps. MV3, one codebase for Chrome and Firefox.

**Build**: `extension/` — content script runs the **same** JSON-LD extractor as 2.1 (shared, not reimplemented), pops a preview, posts to a configured SmartChef instance. Needs the server URL and a session; simplest path is an extension-scoped token issued from the Account page rather than sharing the app's cookie.

**Depends on 2.1.** Do not start it before the extractor exists and is proven.

---

## Order of execution

1. Shopping list by aisle — *hours*
2. Structured-data URL import — *the highest-value item; do it as early as its size allows*
3. Cook mode + wake lock
4. Step timers
5. Unit/temperature/tin converter
6. Migration importers — Paprika and Mealie first
7. PDF import, then photo/OCR
8. Drag-and-drop planner
9. Pantry + `filter-by-pantry`
10. Public share links (server mode; scope confirmed first)
11. Browser extension

Items 1–5 are independent and can land in any order if something blocks. 11 depends on 2. 9 wants 5 for unit comparison but degrades gracefully without it.
