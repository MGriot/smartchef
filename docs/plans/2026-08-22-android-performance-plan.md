# Android standalone-mode performance — findings & plan

**Trigger**: two related user reports — "the Android app goes slow after importing a few recipes" and, separately, "the gallery is slow too." Both point at the same page (Home.tsx's Gallery, `gallery.title`), which is standalone mode's `GET /api/recipes` equivalent — `services/recipes.local.ts`'s `listRecipes()` — so they're very likely the same root cause seen from two angles: import adds recipes, and every added recipe makes the next gallery load slower.

## Root cause found and fixed this session

`listRecipes()` called `buildTagsDisplay(tagNames, lang)` once **per recipe** in its result-assembly loop. That function itself looped over the recipe's own tag names and, per tag, ran up to two sequential `await`ed queries (one for the tag row, one for its translation). Net cost for a gallery load: `recipes × tags × (1 or 2)` sequential round-trips through `@capacitor-community/sqlite`'s query bridge.

That bridge is not free on Android: `db/local.ts`'s `exec()` calls `SQLiteDBConnection.query()`, which is a real Capacitor plugin call — it crosses into native Java/Kotlin per invocation, with per-call latency that a purely in-process call wouldn't have. A gallery of a few dozen tagged recipes could easily mean several hundred sequential bridge round-trips on every load, which matches both symptoms: it gets worse the more recipes exist (import), and it's the gallery's own list query, not something import-specific (gallery slowness).

**Fix** (`frontend/src/services/recipes.local.ts`): replaced the per-recipe/per-tag loop with `buildTagsDisplayBatch()` — collects every distinct tag name across the whole result set once, resolves it in exactly 2 queries total (one `IN (...)` for tag rows, one `IN (...)` for translations), and slices per recipe from the returned map via `tagsDisplayFromBatch()`. `getRecipe()` (single-recipe view) now goes through the same batch function too, dropping its own tag lookups from `tags × 2` to 2. Verified: 181 tests passing, typecheck clean.

## Known, not yet fixed — same anti-pattern, smaller blast radius

`getRecipe()` (single recipe detail page) still has a sequential per-row `await` inside its ingredients loop (`recipe_ingredients` → per-row translated-name + notes lookups, lines ~403-423) and a similar pattern for steps. Same category of bug as the one just fixed, but bounded by *one recipe's* ingredient/step count rather than the whole library — much less severe, since it doesn't compound with library growth the way the gallery query did. Worth the same batch treatment if RecipeDetail.tsx is ever reported as slow, but not urgent on its own.

**General rule worth keeping in mind for future `*.local.ts` work**: any loop that does `await query(...)` once per row, inside a function that itself runs once per item in a list, is an N+1 that will specifically hurt on Android (the sqlite/filesystem plugin bridges have real per-call cost that doesn't show up testing on Electron/desktop, where the equivalent calls are closer to free). Batch with `IN (...)` and a lookup map instead, the same shape as `buildTagsDisplayBatch()` above.

## Other Android-specific performance factors (not yet investigated in code, lower confidence)

These weren't confirmed by reading code this session — noted here as the next places to look if slowness persists after the fix above, roughly in priority order:

1. **Sync runs on the main JS thread.** `gitSync.ts`'s sync cycle (commit/merge/push/pull) is plain async JS on the same thread that renders the UI. A multi-second sync cycle can make the app feel frozen even if nothing else is wrong. Low-effort mitigation already available: the configurable auto-sync interval (Account → Folder Sync) — widening it (e.g. 5m → 30m/1h) directly reduces how often this cost is paid in the background. No code change needed for that part.
2. **Git object store is never packed/GC'd.** `gitObjectTransport.ts` deliberately keeps every object as a separate loose file (documented tradeoff, see ADR 0001) — every edit adds more small files that are never consolidated. Combined with Android's Filesystem-plugin bridge (same per-call-cost story as SQLite above), local git operations (`commit`, `merge`, `resync`) plausibly get slower as the object count grows, independent of the SQLite fix above. A real fix would mean periodically packing loose objects into one packfile and deleting the originals — the primitives already exist in `gitBundleTransport.ts` (`packObjects()`/`indexPack()`), so this would extend existing code rather than introduce a new dependency. Scope this as its own ticket rather than folding it into a "gallery is slow" fix — it touches every device's git storage and deserves its own testing pass.
3. **Recipe cover images are plain remote URLs, not local files.** `Home.tsx`'s `CoverImage` component's own comment confirms: "Recipe photos ... are plain remote URLs, never cached locally." Standalone mode's `recipes.local.ts` has no local image storage path at all yet (this is the still-open image-storage/dedup wayfinder ticket). This isn't an Android-bridge-latency issue like 1-2 above — it's a plain network-image-loading cost, and it means every gallery scroll refetches images over the network with no offline/caching benefit. Out of scope for this plan (belongs to the separate image-storage design work); noted here only because it's a real contributor to perceived gallery slowness on a slow connection.

## Out of scope for this plan

- Redesigning image storage/dedup — tracked separately (wayfinder ticket 05, image storage & dedup format), not duplicated here.
- Git repacking/GC implementation — sized as its own follow-up (item 2 above), not attempted in this pass; the fix in this plan was scoped to the concrete, reported, cheaply-fixable bug (item 1, now done), not a general performance rewrite.
