# TODO

## Catalog-aware import matching (2026-09-18)

- [x] **AI import now recognizes the library it's importing into** — the recipe-parse prompt (server and standalone) is handed the library's own ingredient/tool/technique names, labelled in the app's content language, and asked which one each parsed item corresponds to (`catalogName`), instead of coining fresh wording every time.
  - New `importCatalog.service.ts` (server) / `importCatalog.local.ts` (standalone) twins load one query per entity type — deliberately not built on `proposeIngredientMatches()`/`listIngredients()`, which read fields (plurals, synonyms, tags, translations) this only needs two columns of. Ingredients are capped at 400, ordered by usage so a library that grows past the cap loses its least-used rows rather than everything alphabetically after "P".
  - The catalog prompt and its rendering are **twinned** between `backend/src/services/llm.parser.ts` and `frontend/src/services/llmParser.local.ts` inside `BEGIN/END TWIN BLOCK` markers, enforced by a new `llmParser.promptParity.test.ts` that diffs the two files' marked blocks byte-for-byte — the two had already drifted by one character (`->` vs `→`) before this existed to catch it.
  - **Ollama never gets the ingredient list** (tools/techniques only) — it's the one provider that doesn't set `num_ctx`, so a ~2000-token ingredient list would silently overflow its default context window and get answered from whatever's left, not an error. Anthropic/Gemini/OpenAI get the full list.
  - `dropUnknownCatalogNames()` re-validates every `catalogName` the model returns against the catalog **actually sent to that provider** (not the full catalog) before anything acts on it — a claim naming a real row the model was never shown, or a plausible-sounding invention, is dropped to null and surfaces as a warning instead of silently merging a distinct ingredient into an existing one.
  - On the review screen, `lib/importMatching.ts`'s `mergeSuggestions()` combines the fuzzy-name matches with the model's catalog claim into one ranked list; a match found *only* via the catalog claim is flagged `viaCatalog` and badged "AI match" in the UI rather than auto-selected unmarked — that badge is the entire safety story, since with an empty catalog claim (every non-AI import path) this returns byte-for-byte the old ranking.
  - 61 new tests across both modes (`importMatching.test.ts`, `importCatalog.local.integration.test.ts`, `importCatalog.roundtrip.integration.test.ts`, `llmParser.catalog.test.ts`, `llmParser.catalogName.test.ts`, `llmParser.promptParity.test.ts`). No backend unit test for `importCatalog.service.ts` directly — `backend/package.json` has no test script, so the promptParity test reaching across the repo from the frontend suite is the only automated check the backend copy gets at all.
  - New `import.aiSuggestedMatch` i18n key, in all four locales.

---

## Feature-parity programme (2026-09-09)

Full plan and reasoning: [`docs/plans/2026-09-09-feature-parity-plan.md`](docs/plans/2026-09-09-feature-parity-plan.md).
Eleven capabilities from the competitive read, in execution order. An item is
**done** only when it works in *both* server and standalone mode, has tests, and
is translated into all four locales.

- [x] **1. Shopping list grouped by aisle** ✅ *2026-09-09* — `ingredient_categories.sort_order`/icon/color already exist and both shopping services throw them away to group A–Z. Add category to the item projection, group by it, reorder the categories in the Library. *(hours)*
  - Both services join `ingredient_categories` and carry `categoryId/Name/Color/Icon/SortOrder` onto every item; shared `compareByAisleThenName()` + `groupByAisle()` keep screen, offline screen and Markdown export in one order.
  - Server `generateShoppingList()` now reads the list back through `loadShoppingList()` — the in-memory items it used to return carried no category, so a freshly generated list rendered ungrouped until you navigated away and back.
  - `PUT /ingredients/categories/reorder` (both modes) takes the whole id sequence; up/down arrows in the Library rail, keyboard-reachable, no dnd dependency. Registered **above** `/categories/:id` — Express would otherwise match `reorder` as an id.
  - Uncategorised sinks below every real aisle. 4 new tests (18 in that file).
- [x] **2. Structured-data URL import** ✅ *2026-09-09* — parse `application/ld+json` (then microdata) before touching the LLM; fall back to the current path only when a page has neither. Kills the 6 000-char truncation and the minutes of CPU inference. Needs an outbound-fetch route in standalone too. *(highest value)*
  - `services/recipeStructuredData.ts` — one extractor, **frontend-side**, used by both modes. Runtime code cannot live in `shared/`: the backend's `@shared/*` path is compile-time only and emits `require("@shared/…")` with no resolver (verified with a probe build). So the backend gained `POST /recipes/fetch-page` (keeps the SSRF guard server-side) and standalone fetches through the existing Electron/Android HTTP bridge.
  - Handles the real shapes: `@graph`, `mainEntity`, `@type` arrays, `HowToSection` nesting, `ImageObject` covers, prose `recipeYield`, ISO-8601 durations, comma-joined keywords, one malformed block among several.
  - **Verified against live pages, not just fixtures** — that found three bugs the fixtures missed: `recipeIngredient` was being comma-split (one line became two ingredients), long-form units (`pounds`, `tablespoons`) weren't recognised, and the US metric aside `(1.1kg)` was glued to the ingredient name. All three now have regression tests.
  - Falls through to the LLM on any failure — unreachable page, bot wall, no structured data, or a stub Recipe node with neither ingredients nor steps. Cover image now carried into the created recipe (the import path never set one before). 26 tests.
- [x] **3. Cook mode** ✅ *2026-09-09* — **the plan was wrong here**: a full-screen kitchen mode already existed (`mode=cook` in `RecipeDetail.tsx`), including a second variant that interleaves a sub-recipe's steps with the main one. No new route was needed.
  - Added `hooks/useWakeLock.ts` — there were **zero** `wakeLock` references in the codebase. Re-acquires on `visibilitychange`, because the browser drops the lock whenever the page is hidden and never restores it; without that it would appear to work only sometimes.
  - Tick-off progress now persists per recipe in `localStorage` (it was component state reset on every entry, so stepping out to the shopping list lost the cook). Deliberately not synced — "where I am in tonight's cook" is this device's business.
- [x] **4. Step timers** ✅ *2026-09-09* — `lib/cookTimers.ts`, a module-level store so leaving cook mode does not cancel the roast.
  - Keyed on an **absolute deadline**, never a decremented counter: background tabs are throttled hard, and most of a 45-minute timer runs while you are looking at something else. A timer whose deadline passed while hidden fires the moment the page returns.
  - Several at once (sauce + roast + pasta water), each a chip with a draining progress fill; a fired timer stays until dismissed so "it rang while I was out of the room" is distinguishable from "I never started it".
  - Rings with a Web Audio chime (no asset, no autoplay fight) plus a system notification when granted; permission is asked on first use, not at page load. Native background notifications would need `@capacitor/local-notifications` — a worthwhile upgrade, not a prerequisite.
  - Wired into **both** cook variants; the sub-recipe one namespaces timer ids by section since step numbers restart per sub-recipe. 10 tests.
- [x] **5. Unit / temperature / tin-size converter** ✅ *2026-09-09* — `lib/unitConvert.ts`, pure and display-only; nothing is ever written back.
  - **Not** driven by `units.to_base_factor` after all: the seeded catalogue is metric-only (g, kg, ml, l, tbsp, tsp, cup) with no imperial rows, so a conversion through it would have had nothing to convert *to*. The table is keyed by symbol, covers both systems, needs no migration and survives a unit being deleted from the Library.
  - Metric ↔ imperial toggle on the recipe page, remembered per device. Picks the unit a cook would say (1 200 g → 1.2 kg, not 1200 g). Leaves alone: countable units (`pz`), vague ones (`q.b.`), a `quantityText` with no number, anything already in the target system, and **spoons** — an explicit `neutral` flag, because "1 tbsp" restated as "0.5 fl oz" helps nobody.
  - `ConverterPanel` for the two things the recipe cannot know: oven temperature (°C/°F/gas mark — affine, so 180 °C is 356 °F not 324, rounded to a setting an oven actually has) and tin size (**scaled by area, not diameter** — 20→23 cm is 32% more mixture, not 15%).
  - 22 tests, including that `convert('g','ml')` is null (needs a density a recipe doesn't carry) and that tin factors are symmetric and never 0 or ∞.
- [x] **6. Migration importers** ✅ *2026-09-09* — **not** adapters onto `Snapshot` as the plan assumed: a Snapshot needs ingredient ids and categories, which a foreign export has none of, so it would have minted duplicates on import. They produce `TemplateParseResult[]` instead and go through the existing fuzzy matcher.
  - `lib/zipReader.ts` — ~100 lines, no dependency, using the platform's `DecompressionStream` (Chromium 103+, fine on Electron 114). STORED + DEFLATE, clear errors on ZIP64/encrypted. Tested against **real archives built with Node's zlib**, not byte fixtures.
  - `services/migration/adapters.ts` — Paprika (zip of individually *gzipped* JSON, the detail naive readers miss), Mealie (structured `food`/`unit` objects, falling back to parsing `display`), Crouton, Mela, Nextcloud Cookbook / RecipeSage / any schema.org JSON, and CopyMeThat's HTML (which still carries its JSON-LD, so the item-2 extractor reads it). Paprika's `"For the sauce:"` headings become ingredient **groups**, not ingredients.
  - `services/migration/bulkImport.ts` — matches every distinct name **once for the whole batch**, not per recipe: 200 recipes mentioning "olive oil" a hundred times ask once. Creation is sequential on purpose — concurrent creates race the same new ingredient into duplicates, the exact failure this exists to prevent. One bad recipe never abandons the other 199.
  - Only names the matcher was *unsure* about reach the user; a confident match needs no decision and a name with no candidates is unambiguously new.
  - 24 tests. Bug caught by them: Mealie's `display` line was being taken as an ingredient *name*, producing ingredients literally called "3 tbsp extra-virgin olive oil".
- [x] **7. PDF and photo/OCR import** ✅ *2026-09-09* — new "Photo / PDF" tab; extracted text lands in the raw-text box for review rather than importing straight off. **Verified end to end 2026-09-09**: driven through a temporary browser harness against a canvas-rendered recipe, tesseract downloaded its model and returned all five lines — title, three quantified ingredients and the step — with quantities and units intact. The `?url` shims for the worker and wasm core resolve to the real emitted assets in `dist/`, which is the failure the pdf.js worker already hit once.
  - `pdfText.ts` uses pdf.js's **legacy** build: 4.x's default bundle targets browsers newer than the Electron 25 shell (Chromium 114). Verifying in the dev browser would have hidden that.
  - pdf.js gives positioned fragments, not lines, so they are regrouped by y-coordinate — without it an ingredient list arrives as one run-on paragraph and every line-based parser downstream has nothing to split on. Tested against **real hand-built PDFs** with a correct xref, not a mocked pdf.js.
  - `hasTextLayer` needs **both** ≥3 lines and ≥40 non-space characters: a line count alone lets a watermark through, and a character threshold high enough to exclude one would reject a genuinely short recipe. A scanned PDF says so instead of importing an empty recipe.
  - `ocr.ts` runs Tesseract **on device** — the differentiator, since Mealie's OCR and Cooklang's scraper both call OpenAI. Engine and wasm are bundled; only the ~12 MB language model downloads on first use, then caches. The UI says so, and says handwriting is unreliable.
  - Both dynamically imported and verified code-split: 3.8 MB wasm + 1.4 MB pdf worker are separate chunks, main bundle grew ~30 KB.
  - **Untested end to end:** OCR needs a real photo plus network for the first model fetch. The PDF path is covered by 4 tests.
- [x] **8. Drag-and-drop planner** ✅ *2026-09-09* — `react-beautiful-dnd` removed (dead dependency, deprecated upstream); `@dnd-kit/core` in its place, chosen over the rbd fork because a week grid needs arbitrary droppables rather than lists.
  - Needed a **move** endpoint that did not exist: `PATCH /menus/:menuId/items/:itemId`, partial (COALESCE) so dragging a card to another day does not clobber the servings or meal someone set. Added in **both** modes with a localRouter entry and 2 tests.
  - Drag handle rather than a draggable card: making the whole card draggable swallows clicks and fights text selection. dnd-kit's `KeyboardSensor` makes the drag itself keyboard-reachable, and each day keeps its "+" button, so dragging is an addition and never the only route.
  - Optimistic move, re-fetch on failure — the server is the truth and re-reading it beats reversing the move by hand.
- [x] **9. Pantry + `filter-by-pantry`** ✅ *2026-09-09* — the reserved endpoint is implemented at last, against the contract exactly as frozen.
  - `isOptional` now travels through the matrioska engine (both sides). It was read from `recipe_ingredients` all along and never propagated, so "can I cook this?" would have counted a missing garnish against a recipe.
  - Matching resolves each recipe through the engine first, so a dish whose sauce is itself a recipe is checked against its **whole tree** — KitchenOwl is the only rival with a pantry and it has no sub-recipes, so none of them can answer this. There is a test for exactly that.
  - Contract rules honoured: no quantity means "I have some"; optional ingredients never count against; an amount that cannot be compared counts as satisfied, because refusing to suggest a recipe over "a pinch of salt" would make the feature useless.
  - `UNIQUE(owner_id, ingredient_id)` so topping up edits the row instead of leaving two "flour" lines for the matcher to sum.
  - **Pre-existing bug found and fixed:** `/api/recipes/parse` and `/filter-by-pantry` are two-segment paths, so `sub` is undefined and the `if (!sub)` id-branch claimed them first — the `parse` special case had been **unreachable**, returning the generic offline message instead of its own. Both moved above the id branches.
  - 7 new tests (27 in that file), 383 total.
- [x] **10. Public share links** ✅ *2026-09-09* — server mode only, exactly as scoped.
  - `039_share_links.sql` + `routes/publicShare.ts`, split into two routers so the distinction is structural: the owner half sits **under** the auth gate, the public half is mounted before it and is the app's only unauthenticated read path.
  - Tokens are 32 bytes of `crypto.randomBytes`, base64url — never derived from the recipe id, which would make every recipe public at once.
  - The public projection is an **allowlist built field by field**, not the internal recipe minus a few keys: the subtractive version silently publishes every column added later. Creator, ratings and cook log are not included, and `{{ing:N}}`/`{{tool:uuid}}` step tokens are stripped rather than leaking internal ids.
  - `GET /public/r/:token` is a real server-rendered HTML page, because a link pasted into a chat is previewed by fetching it as a document — a JSON endpoint yields no title, image or description. No JavaScript, `noindex`, works for crawler and person alike.
  - Standalone says why a link cannot exist there and offers the file export instead, rather than leaving a dead control on the page.
- [~] **11. Browser clipper extension** — **dropped on request** (2026-09-09). The structured-data extractor it would have reused (item 2) exists and is tested, so this stays cheap to pick up later.

### Standing rules for every item above

- A new `/api/*` namespace **must** get a `services/localRouter.ts` entry plus an integration test asserting `dispatchLocal(...)` is not `null` — otherwise it is a silent dead button in standalone. This has bitten four times already.
- Electron ships Chromium 114; CSS newer than that is inert in the desktop build.
- `src/i18n/locales.test.ts` enforces `en/it/fr/es` parity.

---

## Server-mode deploy — 2026-09-09

Done, against the existing `docker` compose project (run from `docker/`, not
the repo root — only `docker/.env` carries `SESSION_SECRET`, `CORS_ORIGIN`
and the `COOKIE_*` settings the Android app's cross-origin login needs).

- Migrations `039_share_links.sql` and `040_pantry.sql` applied by hand to
  the live database. They had to be: `docker-compose.yml` mounts
  `db/migrations` at `/docker-entrypoint-initdb.d`, which Postgres runs
  **only when initialising an empty data directory**, so nothing in there
  reaches an existing `pg_data` volume. Both files are `CREATE TABLE IF NOT
  EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-running them is harmless.
  `recipe_share_links` and `pantry_items` verified present with their
  foreign keys and the `(owner_id, ingredient_id)` unique constraint.
- Backend, frontend and MCP images rebuilt and recreated. `/api/pantry`,
  `/api/share` and `/api/public` are mounted in the running container, and
  the two unauthenticated routes answer for real: `/api/public/recipes/:token`
  returns the handler's own JSON error for an unknown token and
  `/api/public/r/:token` returns the server-rendered HTML page. An unmounted
  path under `/api/public` falls through to the auth gate and returns 401,
  which is how those two were told apart from a 404.

### The 8080 problem, and why the frontend now publishes 8888

`http://localhost:8080` was refused on the Windows host even though the
container served 200 inside the podman VM. WinNAT had reserved `7981-8080`
(along with `8081-8180`, `8181-8280`, `8281-8380` and `8407-8506`), so
nothing on the host — including WSL's port relay, which forwarded 3000,
3002, 5432 and 11434 without trouble — could bind it. `tailscale serve`
proxies the tailnet URL to that same local port, so it went down with it.
Inspect the current reservations with:

    netsh interface ipv4 show excludedportrange protocol=tcp

Resolved by republishing the frontend on `8888:80` and repointing
`tailscale serve` at 8888. `https://desktop-kk1837d.tailf16a9a.ts.net`
serves the app and proxies the API again. The alternatives — a reboot, or
`net stop winnat && net start winnat` as administrator — both change a
system setting and would only hold until the ranges reshuffle again.

To go back to 8080 if a reboot frees it: change the port in
`docker/docker-compose.yml`, `podman compose up -d frontend`, then
`tailscale serve --bg 8080`.

---

## Performance pass — 2026-09-09

Measured before/after on this machine, `npm run build` + the standalone
SQLite test harness. No features were removed or gated.

### Startup and download

| | before | after |
|---|---|---|
| main JS bundle | 1939 KB | 476 KB |
| Material Symbols font | 3868 KB | 240 KB |
| PWA precache (first-install download) | 6797 KB | 2107 KB |

- **Route splitting** — every one of the 23 pages was a static import in
  `App.tsx`, so the first bundle carried all of them. They are `lazy()` now,
  behind one `<Suspense>` whose fallback is the same spinner as the boot
  state. Login, ServerConnect and ProfilePicker stay eager: they are what
  renders first, and deferring them would only add a blank frame.
- **The maps are behind a lazy shell** — `RegionsMap.tsx` / `AtlasMap.tsx`
  are now thin `lazy()` wrappers over `*View.tsx`. They pull
  `lib/worldGeo.ts`, which statically imports 739 KB of country boundaries
  and converts the topology at module scope; that 925 KB chunk used to be
  reachable from the recipe page whether or not the recipe had a region.
- **The icon font is subset to what the app uses** —
  `scripts/subset-material-symbols.py`, wired in as `prebuild` and
  `npm run icons:subset`. The package ships all ~4,300 icons as one 3.9 MB
  variable font at `font-display: block`, so every cold start rendered a UI
  with no icons at all until it arrived. The app names about 350. Subsetting
  an icon font needs `--glyphs` plus `--no-layout-closure` — asking for the
  letters a-z keeps every ligature buildable from them, i.e. all of them —
  and the script verifies each icon still resolves before writing.
  `src/fonts/iconCoverage.test.ts` fails if the source outgrows the
  committed font, so a forgotten regeneration shows up in the test run
  rather than as the word "thermostat" on screen.
- **The precache no longer carries the on-demand chunks** — the tesseract
  OCR core (3.8 MB), its worker, pdf.js, the world map and the git remote
  transport were 5.5 MB of a 6.8 MB install for features most sessions never
  touch. They are excluded from the precache manifest and picked up by a
  `CacheFirst` runtime rule instead, so each still works offline once used.
  woff2 was added to the precache in exchange, so a first offline load has
  its own type and icons.

### Query counts in standalone mode

Every query here is a Capacitor bridge round-trip on Android, which is what
`docs/plans/2026-08-22-android-performance-plan.md` was written about.

| | before | after |
|---|---|---|
| `getRecipe()`, 20 ingredients + 20 steps | ~110 | 11 |
| `filterByPantry()`, 13 recipes | ~29 | 4 |
| `listCollections()`, N collections | N + 1 | 2 |

- **`getRecipe()`** resolved translations row by row — three queries per
  ingredient, two per step, one per tool, two per technique. All of it is
  batched through `chunk()` + `inPlaceholders()` now, the same way
  `listIngredients()` already was, and the current-language row is picked in
  JS by `matchesLang()`, which keeps SQL's `LOWER(a) = LOWER(b)` rule.
  Covered by `recipes.local.getrecipe.integration.test.ts`, including a
  guard that the count does not grow with the recipe.
- **`filterByPantry()`** called `calculatePortions()` per recipe, costing a
  query per node of each sub-recipe tree. `preloadMatrioska()` reads the
  whole library's rows in two queries and the existing recursion reads from
  that map — no second copy of the resolution rules. Covered by
  `pantry.local.integration.test.ts`.
- **Cook mode** (`loadSectionTechniques`) queried once per technique chip,
  per section, all the way down the matrioska tree. Batched.

The backend was checked for the same shapes and does not have them: its
`GET /recipes/:id` resolves every translation in one statement with joins
and subqueries. Only the standalone port had drifted into per-row loops.

### Follow-up pass

- `exportSnapshot()` in `backup.local.ts` batched: 19 reads flat, where it
  used to be one query per category, tag, ingredient, tool and technique,
  four more per recipe, and one per ingredient row for its translations plus
  another for its unit. Covered by `backup.local.integration.test.ts`, which
  also pins the grouping — a bug that attaches every child to the first
  parent is the failure mode of doing this in JS, so the fixture has two of
  each parent and asserts which child landed where.
- `share.local.ts` no longer queries step translations per step. Smaller
  win: a bundle is one recipe and its sub-recipes, not the library.

### Still not done

- The 925 KB `worldGeo` chunk is deferred, not smaller.
  `world-atlas/countries-50m.json` is more precision than a country-level
  pin map needs; `countries-110m.json` is roughly a fifth the size. Left
  alone because it visibly coarsens the borders, which is a look-and-feel
  call rather than a free win.

---

## Older items

## 1. Ingredient library doesn't show all ingredients after a category change — ✅ FIXED

**Resolved.** The `LIMIT 200` was the cause and is gone from both implementations: the cap is now `SEARCH_RESULT_LIMIT`, applied only to the `q` search path, and the unfiltered listing every client-side grouping/matching caller depends on is uncapped. See the comments on that constant in `backend/src/routes/ingredients.ts` and `frontend/src/services/ingredients.local.ts`. The original analysis below is kept for context.

### Original report

**Report:** changing an ingredient's category (e.g. "Carrots" moved into "Vegetables") makes it disappear from the ingredient library tab.

**Likely cause, confirmed while investigating:** both the server and standalone ingredient-list queries have a hard `LIMIT 200` with no pagination:
- `backend/src/routes/ingredients.ts` — `GET /` (~line 47)
- `frontend/src/services/ingredients.local.ts` — `listIngredients()` (~line 82)

`frontend/src/pages/LibraryIngredients.tsx` fetches this list exactly once, unfiltered, then buckets the results into per-category `<details>` sections client-side (`ingredients.filter(i => i.category_id === c.id)`, ~line 588). If the library has more than ~200 ingredients, anything past that cutoff never reaches the page in the first place — and since the query orders by `category name, ingredient name`, moving an ingredient into a category makes it change position in that order, which can push it (or others) past the 200-row line depending on total count and where "Vegetables" sorts alphabetically.

**To do:**
- Confirm actual ingredient count in the affected library (if under ~200, the LIMIT theory is wrong and needs a different explanation — e.g. a stale client-side cache after the edit, check `handleSave`/refresh logic in `LibraryIngredients.tsx`).
- If it is the LIMIT: either raise/remove the cap for this specific listing (the page already fetches everything up front for client-side grouping, so it needs the full set, not a capped page) or add real pagination to `LibraryIngredients.tsx` and both `GET /ingredients` implementations.
- Apply the same fix to both the server (`backend/src/routes/ingredients.ts`) and standalone (`frontend/src/services/ingredients.local.ts`) code paths — they're independent implementations of the same query.

## 2. Full translation pass on the Windows app's recipe and ingredient screens — ✅ SCOPED SCREENS DONE

**The screens this item names are clean.** A scan of `RecipeDetail.tsx`,
`RecipeCreate.tsx`, `RecipeImport.tsx`, `LibraryIngredients.tsx` and the
shared components for JSX text nodes and user-visible attributes
(`placeholder`, `title`, `aria-label`, `alt`) holding literal English turned
up four real strings, now keyed in all four locales:

- `RecipeDetail.tsx` — the sub-recipe list's "Loading…" (`common.loading`)
- `Modal.tsx` — the close button's `aria-label` (`common.close`)
- `Form.tsx` — the remove-translation `aria-label`
  (`common.removeTranslation`)
- `TagPicker.tsx` — the empty-catalogue line (`tagPicker.emptyCatalog`)

The three remaining hits on those screens are scanner false positives: a
`&middot;`, the literal `.smartchef.json`, and a fragment of TypeScript that
looks like JSX text.

**What the scan also found, outside this item's scope:** roughly 200
candidate strings elsewhere, concentrated in `Account.tsx` (79),
`LibraryTags.tsx` (25), `ServerConnect.tsx` (23), `LibraryUnits.tsx` (20)
and `ManageUsers.tsx` (14). Settings and library-management surfaces rather
than the cooking ones. Not started — it is a much larger job than this item
described, and worth deciding on separately.

### Original scope

Audit the recipe list/detail/editor and ingredient library screens for any remaining hardcoded (non-`t()`) English strings, then fill in the corresponding `it`/`en`/`fr`/`es` keys in `frontend/src/i18n/locales/*.json` so those screens are fully translated in all four supported languages.

**Suggested approach:**
- Grep each target page (`RecipeDetail.tsx`, `RecipeCreate.tsx`, `RecipeImport.tsx`, `LibraryIngredients.tsx`, and their shared components like `Autocomplete.tsx`, `StepEditor.tsx`, `RecipeSourcesEditor.tsx`) for string literals in JSX that aren't wrapped in `t(...)`.
- Several i18n keys were added this session only in `it`/`en`/`fr`/`es` together (see `import.*`, `recipeDetail.pluralOptional`, `recipeDetail.ingredientNeedsMatching`, etc.) — double check none were missed in any one locale file, since a missing key silently falls back to the key name itself rather than erroring.
- Watch for strings built by string concatenation or template literals outside `t()` (these are easy to miss with a plain string-literal grep).
