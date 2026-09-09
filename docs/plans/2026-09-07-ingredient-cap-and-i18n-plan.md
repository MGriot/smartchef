# Ingredient library 200-row cap + recipe/ingredient i18n pass — findings & plan

**Trigger**: `TODO.md` items 1 and 2. Both were investigated against the actual code and the 2026-08-19 backup before writing this plan; item 1's stated hypothesis is **confirmed and is worse than described**, item 2's stated hypothesis is **partly wrong** and the real work is somewhere else.

---

## Item 1 — "an ingredient disappears after a category change"

### Root cause: confirmed, with numbers

`smartchef-backup-2026-08-19.json` holds **220 ingredients** across 12 categories. Both list queries cap at 200:

- `backend/src/routes/ingredients.ts:48` — `GET /ingredients`, `LIMIT 200`
- `frontend/src/services/ingredients.local.ts:82` — `listIngredients()`, `LIMIT 200`

Both order by `COALESCE(ic.name, 'Uncategorized'), i.name`. Of the 12 categories, **`Verdure & Ortaggi` sorts last alphabetically** and has 27 members — so rows 201-220 are *entirely* that category:

```
201  Verdure & Ortaggi  Fresh Basil        211  Verdure & Ortaggi  San Marzano Tomatoes
202  Verdure & Ortaggi  Fresh Parsley      212  Verdure & Ortaggi  Shallot
...                                        ...
210  Verdure & Ortaggi  Red Onion          220  Verdure & Ortaggi  Zucchini
```

Only 7 of the 27 vegetables survive the cut. Moving an ingredient *into* Vegetables relocates it to the last category block, past the cutoff, and it vanishes — exactly the reported symptom. No cache/refresh bug is involved; `handleSave` correctly re-fetches, the re-fetch just returns a truncated set.

### Blast radius is larger than TODO.md assumed

**Five** call sites fetch the full unfiltered list and are all silently truncated — not just the library page:

| Call site | Consequence |
|---|---|
| `pages/LibraryIngredients.tsx:59` | the reported bug; also caps the merge-target picker, which reuses the same in-memory array |
| `pages/LibrarySeasonality.tsx:38` | 20 ingredients missing from the seasonality calendar |
| `pages/RecipeCreate.tsx:177` | ingredient autocomplete cannot offer anything past row 200 |
| `pages/RecipeDetail.tsx:380` | same, in the inline editor |
| `services/localMatcher.ts:14` (`listIngredients({})`) | **worst one** — the AI-import auto-matcher cannot see the tail of the library, so importing a recipe that names "Zucchini" fails to match the existing row and **creates a duplicate ingredient**. Silent data corruption that compounds: every duplicate created makes the library bigger, pushing more rows past the cap. |

The `?q=` search path (`RecipeImport.tsx:218`'s `runSearch`) is unaffected — there the 200 is a sane result cap and should stay.

### Fix, in order (order matters)

**Do not simply delete the `LIMIT`.** `listIngredients()` is an N+1 of exactly the shape `docs/plans/2026-08-22-android-performance-plan.md` was written to eliminate: per returned row it awaits a translations query, a category-translation query and a tags query, then **one more query per tag** for the tag translation. At 200 rows that is already ~600-900 sequential `@capacitor-community/sqlite` bridge round-trips per library load; uncapping makes that unbounded and growing with library size. Removing the cap first would fix the correctness bug and re-introduce the Android slowness bug that plan just finished fixing.

1. **Batch `listIngredients()` first.** Replace the four per-row/per-tag lookups with whole-result-set `IN (...)` queries plus lookup maps — same shape as `recipes.local.ts`'s existing `buildTagsDisplayBatch()` / `tagsDisplayFromBatch()`. Target: constant ~4 queries regardless of row count. Verify the suite is still green before touching the limit.
2. **Then uncap.** Drop `LIMIT 200` on the unfiltered path in both implementations; keep a bounded limit (e.g. `LIMIT 200`) when `q` is present. The page fetches everything up front for client-side grouping, so it genuinely needs the full set — real pagination would mean rewriting the `<details>`-per-category grouping and is not worth it at this library size.
3. **Backend needs no batching** — Postgres already nests translations/tags via `json_agg` in the single query. Just remove the `LIMIT` there.

### Test

`services/ingredients.local.sync.integration.test.ts` already mocks `@capacitor-community/sqlite` with `node:sqlite`'s `DatabaseSync` — **real SQLite, the same `SCHEMA_SQL` and the same `listIngredients()` the app ships**. Reuse that harness:

- seed >200 ingredients spread across categories, assert `listIngredients({})` returns all of them;
- assert an ingredient in the last-sorting category is present (the specific reported failure);
- assert the batched version returns identical rows to the current one for a small fixture (guards the refactor in step 1).

Note `frontend/vitest.config.ts` includes `src/**/*.test.ts` only — **not `.tsx`** — so this is a service-layer test; there is no component-test path today and adding one is out of scope.

### Noted, not fixing

`ORDER BY COALESCE(ic.name, ...)` sorts by the *untranslated* category name while the UI groups by category id and renders translated names, so category order can look arbitrary in a non-English UI. Cosmetic, unrelated to the bug, worth a separate look.

---

## Item 2 — translation pass

### TODO.md's premise needs one correction

> "a missing key silently falls back to the key name itself rather than erroring"

`i18n/index.ts` sets `fallbackLng: "en"`. A key missing from `it`/`fr`/`es` falls back to the **English string**, not the key name. Key-name display only happens for a key missing from `en.json` as well. The failure mode is therefore "silent English inside an Italian UI" — real, but milder than stated.

### Key parity: almost fine

`en` 303 keys, `it`/`fr`/`es` 300 each. Exactly **3 keys** are missing from all three, all in one namespace:

```
login.networkError   login.username   login.usernamePlaceholder
```

The `import.*` and `recipeDetail.*` keys the TODO flagged as at-risk landed complete in all four files. So gap-filling is a 15-minute job, not the work.

### The real work: one page with zero i18n

| File | Lines | `t()` calls | State |
|---|---|---|---|
| `pages/LibraryIngredients.tsx` | 1131 | **0** | never internationalised at all — does not even import `useTranslation`. ~60-80 strings. **This is the bulk of the job.** |
| `components/StepEditor.tsx` | 277 | 0 | ~18 strings (labels, 3x `placeholder="Search…"`, `"e.g. 10 min / 180°C"`) |
| `components/RecipeSourcesEditor.tsx` | 109 | 0 | 3 labels: Type / Label / URL (optional for books) |
| `components/ImageUrlsEditor.tsx` | 134 | 0 | 2 error strings |
| `components/SynonymsEditor.tsx` | 54 | 0 | 1 placeholder |
| `components/TagPicker.tsx` | 113 | 0 | imports `useTranslation` and destructures `t` at line 35 but **never calls it** — dead code; 1 string `"Custom (not in catalog)"` |
| `components/Autocomplete.tsx` | 148 | 0 | **no work needed** — every visible string arrives via props (`placeholder`, `createNewLabel`, `sublabel`). Audit the call sites instead. |
| `pages/RecipeDetail.tsx` | 2610 | 163 | essentially done; residual is `alert()`/error text (`'Save failed.'`, `'Could not create ingredient'`, `'Translation failed'`, `'Invalid JSON'`) |
| `pages/RecipeCreate.tsx` | 1291 | 84 | same residual pattern (`'Could not create tool'`, `'Could not create technique'`, …) |
| `pages/RecipeImport.tsx` | 798 | 52 | 1 placeholder + error strings |

### Two traps found while scanning

1. **`'Per il condimento'`, `"Per l'impasto"`, `'Come conservare'`** appear in `RecipeDetail.tsx:44` and `RecipeCreate.tsx:33` and look like untranslated Italian UI. They are **inside doc comments** documenting field semantics. Leave them alone. (Their runtime counterparts are user-entered recipe *content*, not chrome — never wrap those in `t()` either.)
2. **`LibraryIngredients.tsx:12`'s `MONTH_LABELS`** is a hardcoded English `['Jan', …]` array rendered at line 1060. Do **not** add 12 keys x 4 locales — `LibrarySeasonality.tsx:46` already solves this correctly with `Intl.DateTimeFormat(i18n.language, { month: 'long' })`. Reuse that.

### Guardrail worth adding

There is no CI and no key-parity check, which is why the 3 `login.*` keys drifted unnoticed. Add `src/i18n/locales.test.ts`: load all four JSON files, flatten, assert identical key sets. Fits the existing `src/**/*.test.ts` include, runs in milliseconds, and permanently closes the class of bug the TODO is worried about.

### Key naming

Extend the existing `library.*` namespace (today only `management` / `kitchenEssentials`) with `library.ingredients.*`; put shared dialog and error strings in `common.*` next to the existing `cancel`/`save`/`delete`.

---

## Sequencing

| Phase | Scope | Status |
|---|---|---|
| **A** | Batch `listIngredients()`, then uncap both implementations, + real-SQLite regression test | **done** |
| **B** | `locales.test.ts` parity guard, fill the 3 `login.*` keys, drop TagPicker's dead `t` | **done** |
| **C** | Full i18n pass on `LibraryIngredients.tsx` incl. `MONTH_LABELS` → `Intl` | **done** |
| **D** | StepEditor / RecipeSourcesEditor / SynonymsEditor / ImageUrlsEditor / TagPicker + residual `alert()` strings in the three recipe pages; audit Autocomplete call sites | **done** |

Verification per phase: `npm test` and `tsc` from `frontend/`. For an installer check, `npm run electron:build` **from `frontend/`** — never `electron:make` from `frontend/electron/`, which ships stale JS.

---

## Outcome

All four phases landed, plus two adjacent defects found while implementing. 253/253 tests pass; both packages typecheck; the production build is clean.

**A.** `listIngredients()` was batched first (four `IN (...)` queries plus lookup maps, chunked at 500 to stay under SQLite's bound-parameter ceiling), *then* uncapped — measured at **4 SELECT round-trips for a 250-row library, down from ~750**, and now constant as the library grows. `inPlaceholders`/`chunk` moved into `db/local.ts` as shared helpers, retiring `recipes.local.ts`'s private copy. Five tests in `ingredients.local.list.integration.test.ts` run against real SQLite; restoring the cap fails four of them. The first version of the "moved into the last category" test passed *with* the cap still in place — the moved row happened to land at exactly row 200 — so its fixture is now named to sort last within its new category. That near-miss also explains why the bug looked intermittent from outside: whether a moved ingredient disappears depends on where its name sorts inside the destination.

**B–D.** All four locale files now carry **446 keys each, at full parity**, guarded by `i18n/locales.test.ts`. `LibraryIngredients.tsx` went from 0 to 104 `t()` calls; `MONTH_LABELS` became an `Intl.DateTimeFormat` hook shared by the page and its detail modal. StepEditor, RecipeSourcesEditor, SynonymsEditor, ImageUrlsEditor and TagPicker are done; `SOURCE_TYPE_META.label` became `labelKey` (nothing outside that file read the text). A re-scan of all ten target files reports **zero remaining hardcoded UI strings**. `Autocomplete.tsx` needed no changes, as predicted — both call sites already pass translated props.

One thing to know: introducing `t` into `LibraryIngredients.tsx` collided with six `map(t => …)` callbacks that shadowed it. They were renamed (`tg`/`tr`). Nothing was broken at the time — no `t('…')` sat inside those scopes — but the next person to add one would have hit a baffling error.

### Two adjacent defects fixed

**Standalone export was silently dead.** `localRouter.ts`'s dispatch list had no `share` entry, so `GET /api/share/recipes/:id/export` fell through to an HTTP request to a server that standalone mode doesn't have, and `RecipeDetail.tsx`'s handler only `console.error`s — so "Export recipe" on the Windows app did nothing, with no message. The export half of `share.ts` is now ported to `share.local.ts` (JSON-TEXT columns decoded, 0/1 columns coerced back to booleans, `ingredient_categories` joined with `LEFT JOIN` rather than the server's inner join so a synced-in ingredient with a foreign `category_id` can't vanish from its own bundle). Eight tests cover it. Import and collection export stay unported — collections have no local table — but are now *claimed* by the router, so they answer "not available offline yet" instead of escaping to the network.

**Fractions were being parsed as their numerators.** `½ carota` reached the library as `quantity: 1` plus a stranded `notes: "/2"` — a doubled amount *and* a nonsense note, which is what surfaced as `1.5 Carrot, /2` in the Cookidoo export. Confirmed across the user's own library (Spezzatino: Carrot, Onion; Korean Fried chicken: five rows with `/4`). `recipeTemplateParser.ts` had the same class of bug independently: its amount group accepted `/` but `parseFirstNumber()` matched only digits, so `- 1/2 cipolla` also became 1. New `lib/ingredientAmount.ts` parses mixed numbers, bare fractions and unicode vulgar fractions (`½`, `¼`, `⅓` — which previously yielded *no* amount at all), and repairs the stranded-denominator split. It is wired into `beginReview()` in `RecipeImport.tsx`, the single funnel both the local parser and the AI response pass through, so the fix does not depend on the model behaving. The repair is deliberately narrow — positive integer quantity **and** a delimited bare `/N` in notes — so a real note like "cook 1/2 hour" is left alone. Scalar fields (servings, times) deliberately keep the old whole-number parser: reading `1 1/2` out of a minutes field as 1.5 would be worse than reading it as 1.

**Existing corrupted rows are not touched.** The fix stops new ones; the ~8 rows already in the library still read `quantity: 1` with a `/N` note and would need a separate, explicitly-approved data repair.

### Also added, outside the original plan

`lib/cookidooExport.ts` — Cookidoo's recipe creator has no import, so the export produces text shaped like its form: one block per field, in the form's order, under Cookidoo's own field names per locale (Titolo / Ingredienti / Passaggi della preparazione / Dispositivi & accessori / Consigli). `Tempo totale` sums prep + cook + rest; ingredients scale to the servings currently being viewed; free-text amounts (`q.b.`) pass through unscaled; ingredient group headers are preserved; steps renumber sequentially so gaps from deleted steps don't show; techniques ride along in Consigli rather than being dropped. Built from the loaded recipe rather than through `/api/share`, so it works offline and in standalone mode. 14 tests.
