# Android standalone-mode performance — second pass

> **Status, 2026-09-12**: items 1–4 of "Suggested order" are implemented and
> merged. What that took, and the one thing it turned up that this plan had
> wrong, is recorded in "What shipped" at the bottom. Items 5–6 are still open.

**Trigger**: "on Windows it goes well, but on Android it's slow — takes time to load a
recipe, and the gallery lags."

Successor to `2026-08-22-android-performance-plan.md`. That pass found and fixed the
tag-display N+1 in `listRecipes()` and packed the git object store. The symptoms are back,
from different causes. Everything below was measured against the real local library
(`C:\Users\Admin\Documents\SmartChef\smartchef_localSQLite.db`: 47 recipes, 53 tags,
20 techniques, 238 ingredients), not estimated.

## Why the same code is fine on Windows and slow on Android

One structural fact explains nearly all of it.

| | Electron (Windows) | Android |
|---|---|---|
| SQLite engine | `better-sqlite3-multiple-ciphers`, synchronous, in-process | `@capacitor-community/sqlite`, native, off-thread |
| How a result crosses | Electron IPC, structured clone | `javaScriptReplyProxy.postMessage(data.toString())` — **result JSON-stringified in Java, `JSON.parse`d in the WebView**, thread hop each way |
| Per-call cost | fractions of a millisecond | milliseconds, plus payload-proportional string cost |

Verified in `node_modules/@capacitor/android/.../MessageHandler.java:126` (and its
`evaluateJavascript` fallback at :142, which splices the whole result into a JS source
string). So **every extra query and every wasted byte is multiplied by a large constant on
Android and by ~nothing on Windows**. On top of that, the two most expensive CSS effects in
the app sit on `md:hidden` elements — markup Windows never renders at all.

## P0 — The gallery payload (biggest single win)

`listRecipes()` (`frontend/src/services/recipes.local.ts:245`) does `SELECT r.*` with no
`LIMIT`. Measured on this library:

```
SQLite execute gallery query                   9.31 ms
JSON.stringify the result (what Java does)     6.81 ms
JSON.parse it back (what the WebView does)     2.76 ms
payload 689 KB

same query, card columns only (no cover blob)  1.08 ms
payload 25.7 KB   <-- 27x smaller
```

689 KB crosses the bridge on **every gallery load, every filter toggle, and every search
keystroke** (300 ms debounce, then a full refetch). Those are desktop-CPU numbers; the phone
pays several times that, plus the string channel.

**Where the 689 KB comes from** — `cover_image_url` alone is 633 KB, averaging 13.8 KB per
row, largest 185,871 characters:

```
cover_image_url shapes across 47 recipes:
  data: URI  -> 9   (total 630 KB of base64 inside the recipes table)
  http(s)    -> 32
  images/    -> 0
  null/empty -> 6
```

Nine recipes store `data:image/webp;base64,...` **inline in the `recipes` table**.
`lib/localImages.ts` already implements exactly the right thing — content-addressed
`images/<sha256>.<ext>` files with dedup, plus `resolveImageSrc()` for display — but **no
recipe uses it** (`images/ -> 0`). The image-storage module landed; cover images never moved
onto it.

**Fix, in order:**

1. **Migrate inline `data:` URIs into the existing image store.** One-time pass at
   `initLocalSchema()` (or a small maintenance action): decode the base64, `storeImage()` it,
   replace the column with the ~40-char `images/<hash>.jpg` path. `CoverImage` already
   resolves that shape via `useResolvedImageSrc`. Fixes the DB, the sync payload and the
   bridge cost together. Also stop writing inline data URIs at the source —
   `RecipeImport.tsx` / `RecipeCreate.tsx`.
2. **Give `listRecipes()` an explicit column list.** The card needs id, title, description,
   difficulty, servings, prep/cook time, rating, tags, times_cooked, creator_name,
   cover_image_url, updated_at. It does not need `tips`, `storage_instructions`, `sources`,
   `region_coords`, `source_url`. Worth ~38 KB on its own, and it stops future column growth
   from silently re-inflating the gallery.
3. **Then consider paging.** With 1 and 2 done the payload is ~26 KB and paging is optional
   at this library size; revisit past a few hundred recipes.

## P0 — Four surviving N+1s, on the hottest paths

The Aug-22 plan's "general rule" (batch with `IN (...)` + a lookup map, as
`buildTagsDisplayBatch()` does) was never applied to these four. Counts are this library's
actual sizes, and they grow linearly:

| Function | Location | Cost | Fires on |
|---|---|---|---|
| `listTags()` | `tags.local.ts:72` | **54** round-trips | gallery mount |
| `listTechniques()` | `techniques.local.ts:63` | **21** round-trips | **every recipe open, in every mode** |
| `listCategories()` | `ingredients.local.ts:389` | **13** round-trips | gallery mount |
| `listUnits()` | `ingredients.local.ts:454` | **10** round-trips | create / edit / pantry / shopping |

`listTechniques()` is the direct answer to "takes time to load a recipe":
`RecipeDetail.tsx:425` fetches `/api/techniques` unconditionally (it needs them to resolve
`{{tech:id}}` tokens in step text), so 21 serialized bridge crossings happen before the page
can render, on top of `getRecipe()`'s ~13.

**Fix**: the `buildTagsDisplayBatch()` shape — one `IN (...)` query for all translations,
slice per row from the map. Four small, mechanical, individually testable rewrites.

## P0 — Gallery images

Independent of the payload problem above, and all three are Android-only pain:

1. **32 recipes point at remote URLs** (Instagram CDN, giallozafferano, …) — all fetched
   simultaneously when the grid mounts, at whatever resolution the source serves, over
   mobile data.
2. **No `loading="lazy"` and no `decoding="async"` anywhere in the codebase** (verified:
   zero occurrences in `src/`). Every card decodes eagerly, including offscreen ones.
3. **No display-sized derivative.** Originals render into ~300 px cards. ADR 0003 settled
   that *sync* carries full-resolution originals — a local thumbnail cache is additive and
   does not contradict it.

**Fix**: add `loading="lazy" decoding="async"` in `CoverImage` (one line, immediate win);
then generate and store a small thumbnail alongside each image at `storeImage()` time and
have `CoverImage` prefer it.

## P1 — Mobile-only compositing costs

`backdrop-filter` forces a separate compositing surface and a readback of everything behind
it. On a phone GPU that is expensive; on a sticky or scrolling element it is paid **every
frame**.

- `Home.tsx:629` — `backdrop-blur-sm` on **every badge on every card**: ~150 blur layers in
  one scrolling grid.
- `Home.tsx:732` — `backdrop-blur-xl` on the `md:hidden` bottom nav: full-width, always on,
  re-blurred every scroll frame. **Windows never renders this element.**
- `RecipeDetail.tsx:843, 1000, 1474` — three `sticky top-0` + `backdrop-blur-md` headers:
  re-blurred every frame while scrolling a recipe.

**Fix**: drop the blur on card badges entirely (they sit on opaque colored pills — the blur
is invisible), and swap the nav/header blurs for an opaque or near-opaque background on
coarse-pointer viewports.

## P1 — Startup and contention

- **`serialize()`** (`db/local.ts:115`) funnels every query through one promise chain.
  Correct for a single-writer SQLite, but it means the gallery's five "parallel"
  `Promise.all` fetches are fully sequential and their latencies **add**.
- **`startFolderSyncWatcher()` fires `syncNow()` immediately at startup**
  (`gitSync.ts:743`) and again on every `resume`. Sync is main-thread JS doing
  isomorphic-git work over the *same* Filesystem bridge, and its writes queue on the *same*
  mutex — so the first gallery load races a full sync cycle. **Fix**: delay the initial and
  resume syncs until after first paint (idle callback / short timer).
- **`initLocalSchema()` runs every launch**: `SCHEMA_SQL` + 17 `PRAGMA table_info` + 3
  `PRAGMA foreign_key_list` + a COUNT ≈ 25 sequential round-trips before the first screen.
  `App.tsx`'s own comment already concedes this "takes seconds" on a cold boot. **Fix**:
  stamp a schema-version value and skip the whole block when it matches.

## P2 — Bundle and render

- All four locale JSONs (~137 KB) are statically imported and parsed at startup
  (`i18n/index.ts:3-6`); one is ever used. Load the active locale lazily.
- `RecipeDetail-*.js` is 109 KB, parsed before the recipe page renders. The file is 3,056
  lines with **2 memo hooks total**; `stepTextTechniques` (line 621) rebuilds the whole
  technique array on every render and is handed to every `RenderStepText`.
- `android/app/build.gradle` sets `minifyEnabled false` on the release build — no R8.
- No gallery virtualization. Not worth doing at 47 recipes; revisit past ~200.

## Checked and ruled out — do not spend effort here

- **Missing indexes.** Every `*_translations` table is covered by its
  `UNIQUE(<parent>_id, language_code)` constraint's implicit index, and `EXPLAIN QUERY PLAN`
  confirms index use on all the hot lookups. Only `profiles(name)` scans (6 rows) and the
  gallery's `ORDER BY updated_at` uses a temp b-tree (46 rows) — both trivial now, cheap
  insurance later, neither is today's problem.
- **`getRecipe()`'s N+1s** — already batched; the Aug-22 follow-up was done.
- **Route code-splitting** — already done in `App.tsx`.
- **Heavy libraries** (tesseract, pdf.js, leaflet, worldGeo) — already separate lazy chunks
  and excluded from precache.
- **A `Filesystem.getUri()` call per gallery card** — would happen for `images/` paths, but
  no recipe currently uses one, so it does not fire. It becomes live once the P0 migration
  lands: memoize resolved paths then.

## Suggested order

1. `loading="lazy"` + `decoding="async"` in `CoverImage` — one line, immediate.
2. The four N+1 batch rewrites — mechanical, testable; removes ~75 gallery round-trips and
   ~21 per recipe open.
3. Inline-`data:`-URI migration into `lib/localImages.ts` + explicit column list in
   `listRecipes()` — the 689 KB → ~26 KB win.
4. Drop the card-badge blur; make the mobile nav and sticky headers opaque.
5. Defer the startup sync past first paint; version-gate `initLocalSchema()`.
6. Thumbnails, lazy locales, `RecipeDetail` memoization, R8.

---

## What shipped (2026-09-12)

### The blocker this plan missed: images never actually synced

Moving inline `data:` covers into `lib/localImages.ts`'s content-addressed store
looked like a self-contained win. It was not. **ADR 0003 specifies that the Hidden
Clone carries full-resolution copies of Local Storage's images, and that half was
never implemented** — `gitSync.ts`'s `ALL_ENTITY_DIRS` only ever listed the JSON
entity directories, there were zero references to the image store anywhere under
`lib/sync/`, and a real Hidden Clone on disk had no `images/` folder at all.

So the migration as originally planned would have regressed a working behaviour: a
`data:` cover travels inside a recipe's entity JSON and *does* reach other devices
today, whereas an `images/<hash>` path would have arrived on another device as a
dangling reference. (Uploads through `ImageUrlInput` already wrote such paths, so
that gap existed — it just would have gone from affecting new uploads to affecting
33 existing photos.)

Image replication was therefore built first, as `lib/sync/imageSync.ts`:

- `copyImagesIntoClone()` before staging, so this device's photos join the history
  it pushes.
- `materializeImagesFromCommit()` after a merge — necessary because
  `mergeRemoteIntoLocal()` never checks the remote tree out, it writes only the
  entity JSON it merged, so images arrived as git objects nothing put on disk.
- `copyImagesOutOfClone()` for the reverse direction.
- `COMMITTED_DIRS` (new) = `ALL_ENTITY_DIRS` + `images` for `statusMatrix`/`add`.

Content-addressing is what keeps this simple: a path encodes its own bytes, so two
devices can never disagree about what one contains. Replication is add-only and
needs no merge, conflict detection or ordering rule — which is also exactly why
`images` must stay **out** of `mergeBridge.ts`'s `ENTITY_DIRS`, which would try to
parse a JPEG as an entity record.

### Results, measured on the real library

| | Before | After |
|---|---|---|
| Gallery list payload | 703 KB | **47 KB** (15× smaller) |
| `recipes.cover_image_url` total | 633 KB | **4.2 KB** |
| `listTags()` on gallery mount | 54 round-trips | **2** |
| `listTechniques()` per recipe open | 21 round-trips | **2** |
| `listCategories()` on gallery mount | 13 round-trips | **2** |
| `listUnits()` | 10 round-trips | **2** |

The migration was rehearsed against a copy of the real database before shipping:
33 of 33 base64 images converted, 1.68 MB freed, every written file verified as a
real WebP/JPEG/PNG by magic bytes, and zero rows left for the next launch to retry.

### One real finding from that rehearsal

The first run failed on one row: a profile avatar stored as
`data:image/svg+xml,%3csvg…` — percent-encoded markup, a few hundred bytes, not a
base64 photo. The migration correctly left it alone (a row that fails keeps its
working image), but it would have failed and logged on **every launch, forever**.
Both `isInlineDataUri()` and the SQL `LIKE` are now scoped to base64 image URIs
specifically, and there is a regression test for the SVG case.

### Also shipped

- **Resolve cache** (`localImages.ts`): `resolveImageSrc()` memoizes per session
  with in-flight de-duplication, and `useResolvedImageSrc()` seeds its initial
  state from it. Re-entering the gallery no longer re-reads every cover or flashes
  every placeholder. Ownership of Electron blob URLs moved to the cache — the hook
  must no longer revoke them.
- **`loading="lazy"` + `decoding="async"`** on every `CoverImage` branch.
- **Blur removal**: card badges (~150 compositing layers, invisible against opaque
  pills), the `md:hidden` bottom nav, and all three sticky `RecipeDetail` headers.
- **Deferred startup** (`App.tsx`): the initial sync and the migration now run
  after first paint via `requestIdleCallback`, instead of racing the first gallery
  load for the bridge and the SQLite mutex.
- **`LIST_COLUMNS`** replaces `SELECT r.*` in `listRecipes()` — the audited union
  of what all seven consumers read, pinned by a test so a new card field fails
  loudly rather than rendering blank.
- **`backup.local.ts`** routes restored `data:` images through `storeImage()`, so
  a restore can no longer put the inline images back.

Batched queries preserve the previous row order (`ORDER BY rowid`) so the
per-language `translations` arrays the editors round-trip are unchanged.

486 tests pass (19 new), typecheck and production build clean.

### Still open

Items 5–6: version-gating `initLocalSchema()` (~25 round-trips every launch),
thumbnails, lazy locale loading, `RecipeDetail` memoization, and R8.
