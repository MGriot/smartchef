# Cross-platform performance — third pass

> **Status, 2026-09-13**: the two items marked **shipped** below are implemented and
> merged. The rest are open, ordered by expected win.

**Trigger**: "the app is slow to load data, recipes and so on on both Android and
Electron."

Successor to `2026-09-12-android-performance-plan.md`. That "and Electron" is the whole
story of this pass. Every prior pass was built on one thesis — *Android's bridge multiplies
round-trips and payload, Windows pays neither* — and every fix followed from it. That thesis
is still true, and the fixes it produced still hold. But it cannot explain a symptom that
shows up equally on a desktop with a synchronous in-process SQLite, so this pass went
looking for what the two platforms have in common instead.

All numbers below were measured against the real local library
(`C:\Users\Admin\Documents\SmartChef\smartchef_localSQLite.db` — 48 recipes, 244
ingredients, 53 tags, 36 tools, 30 techniques), by running the actual service code through
the existing integration-test harness, not estimated.

## The read path is genuinely fixed — start by ruling it out

The Sep-12 work landed and holds. Measured, today, on the real library:

```
GALLERY MOUNT (Home.tsx fires four)
  listRecipes        3 queries |  52 KB |  7.0 ms
  listTags           2 queries |  17 KB |  1.9 ms
  listCategories     2 queries |   5 KB |  1.5 ms
  listCollections    1 query   |   0 KB |  0.5 ms
RECIPE OPEN
  getRecipe         10 queries |  25 KB |  5.3 ms
  listTechniques     2 queries |  10 KB |  1.4 ms
```

Eight queries and 74 KB for a full gallery; twelve for a recipe. Nothing here is worth
another pass, on either platform. **Do not spend effort re-profiling reads.** What follows
is about writes, the mutex that couples writes to reads, and sync.

## P0 — SQLite was running with a rollback journal and `synchronous=FULL` *(shipped)*

Nothing in this codebase ever set `journal_mode`, and neither plugin sets it either — the
Electron one only *reads* the pragma (`plugin.js:2197`), and Android opens through
SQLCipher's `openOrCreateDatabase` with no WAL call anywhere. The live database file
confirmed it: `journal_mode=delete`, `synchronous=2 (FULL)`.

On top of that, **nothing batches**. The plugin's `runSQL` wraps *every single statement* in
its own `BEGIN`/`COMMIT` (its `transaction` option defaults to true, and `db/local.ts`'s
`exec()` calls `db.run(s, p)` without overriding it), and `withTransaction()` is
deliberately not a real transaction either — see its own comment for the nested-transaction
reason. So every individual `INSERT` in a save loop paid a full journal create / fsync /
delete cycle of its own.

Measured, desktop NVMe:

| 200 single-statement writes | |
|---|---|
| `journal=delete` + `synchronous=FULL` (what shipped until now) | **996 ms** — 4.98 ms each |
| `journal=WAL` + `synchronous=NORMAL` | **24 ms** — 0.12 ms each |
| `delete` + `FULL`, wrapped in one transaction | **5.6 ms** |

And on a real save — the largest recipe in the library, 23 ingredients and 8 steps, through
`updateRecipe()`:

> **36 write statements + 34 reads = 292 ms of pure SQLite time**, 8.1 ms per write, before
> any IPC or bridge cost, before `writeEntityFile`, before `scheduleCommit`. Android pays
> the same shape on slower flash through SQLCipher's page encryption.

**Fixed** in `getDb()`: `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=NORMAL`, both with
`execute()`'s second argument set to `false`. That argument is load-bearing, not tidiness —
SQLite documents `PRAGMA journal_mode` as a no-op while a transaction is pending and
`execute()` wraps itself in one by default, which is exactly the trap
`dropDanglingForeignKeys()` already documents having fallen into with `PRAGMA foreign_keys`.
Verified against a copy of the real database: the same 36-write save shape drops from
292 ms to **7.5 ms**, and WAL persists across reopen.

WAL is safe here specifically because **nothing in this app ever copies the database file**
— the `-wal`/`-shm` sidecars would otherwise need a checkpoint first. Backups go through
`exportSnapshot()`'s SQL; the Android mirror replicates the Sync Folder, never Local
Storage. Re-check this before adding any feature that does copy it.

## P0 — Why that shows up as slow *loading*: one mutex couples writes to reads

`serialize()` (`db/local.ts`) is a single FIFO for the entire app, correctly so for a
single-writer SQLite. The consequence is that a sync merge writing a few hundred rows at
~5 ms each **holds the queue for seconds**, and every gallery or recipe read queued behind
it just waits — with no slow query anywhere to find by profiling. This is the mechanism that
made the symptom look like a read problem when reads were already fixed, and it is what
makes the P0 above matter far beyond the save button.

`gitSync.ts`'s `logIfSlow()` already separates "waited for the queue" from "own work" at a
400 ms threshold. Reading `[smartchef/perf]` lines in DevTools during a cold start is the
fastest way to confirm which of this section and the next dominates on a given device.

## P0 — `listTools()` was still an N+1 *(shipped)*

Measured: **31 bridge round-trips for a 30-tool catalog**. The Sep-12 sweep batched
`listTags()`, `listTechniques()`, `listCategories()` and `listUnits()` and missed the fifth
member of the same family. It is not an obscure path — `RecipeDetail` fetches `/api/tools`
on entering edit mode, `RecipeCreate` on mount, and the Tools library page on every visit.

**Fixed** with the same `chunk()` + `inPlaceholders()` rewrite as the other four, preserving
`ORDER BY rowid` so the per-language `translations` arrays the editors round-trip are
unchanged. Now 2 queries regardless of catalog size, pinned by five new cases in
`catalog-lists.local.integration.test.ts` alongside the four it already covered.

Adjacent, still open: `listIngredients(lang)` returns **241 KB across 5 queries** for 244
rows, also on edit-mode entry.

## P1 — The Hidden Clone's object store is 457 MB for a 1.4 MB library

`%APPDATA%/SmartChef/sync-clone/.git` currently holds **69 packfiles totalling 432 MB**,
against a working tree of 517 files and a database with roughly 1.4 MB of actual content.
Two distinct contributors, only one of which is fully understood:

- **30 `pack-gc-*` packs, 78 MB.** `packLooseObjectsAfterPush()` writes a new pack per run
  and never consolidates or removes older ones — it does not `readdir` the existing packs at
  all. Each run adds one, forever. This one is certain.
- **39 fetch-written packs, 353 MB.** Nineteen are ~12 MB each and near-identical in size,
  which is the signature of each fetch re-downloading most of the history.
  `fetchGitRemote()` does pass `singleBranch` and `tags: false` correctly, so **the
  negotiation itself is what needs investigating** — plausibly its interaction with
  `packLooseObjectsAfterPush()` pruning the loose objects the "have" lines are built from,
  or with the custom tracking-ref name, but that is a hypothesis and not yet confirmed.

Why it costs on the load path: every object lookup that misses loose storage has to consult
up to 69 `.idx` files, and this runs at launch, on **every resume**, and every 5 minutes
(`DEFAULT_SYNC_INTERVAL`). On Android each of those reads crosses the Filesystem bridge.

**Fix**: first confirm the fetch hypothesis (compare a pack's object count against the
history size), then add a pack-count ceiling that consolidates rather than accumulating.
Pruning existing packs is safe only for objects durably on the remote — the rule
`gitPacking.ts`'s header already sets out.

## P1 — `statusMatrix` over the whole working tree, every cycle

`commitNowInternal()` hashes all 517 working files (48 recipes + 310 ingredients + 53 tags +
36 tools + 30 techniques + 34 images) before it can determine whether anything changed —
main-thread JS, one Filesystem-bridge call per file on Android, on the same cadence as
above. **Fix**: skip it when nothing local has changed since the last commit, and back off
the resume-triggered sync.

## P1 — Cover images

36 of 47 covers are remote URLs spread across **16 different hosts** (giallozafferano 14,
salepepe 5, lacucinaitaliana 3, gstatic 2, chefincamicia 2, eleven more with one each), so a
cold gallery pays a DNS + TLS handshake per host — on both platforms. `loading="lazy"` helps
offscreen cards only.

The local store is 34 files / 2.27 MB, with a **1,027 KB largest** rendering into a ~300 px
card. The thumbnail item from the previous plan is still open and is what fixes this half.

## P2 — Smaller, both platforms

- **The database file is 83% empty** — 2110 pages, 1754 on the freelist: 8.6 MB holding
  ~1.4 MB. Never `VACUUM`ed after the inline-image migration freed 1.68 MB.
- **Every standalone API call does a pointless JSON round trip.** `lib/api.ts:91` builds
  `new Response(JSON.stringify(data))` and the caller immediately does `res.json()` —
  stringify plus parse on the main thread, for data that never left the process.
- **`Home.tsx` has zero `useMemo`/`memo`/`useCallback`**, so all 47 cards re-render on every
  search keystroke. `RecipeDetail.tsx` is 3,688 lines with 2 memo hooks (carried over from
  the previous plan, still open).
- **`initLocalSchema()` blocks first paint** with ~20 serialized round-trips. Only 13 ms
  in-process, so this is an Android cost and not an Electron one — the version-gate from the
  previous plan's item 5 is still worth doing, but it is not what desktop users are feeling.
- **The Electron plugin `console.log`s on every write** (`$$$ in runSQL journal_mode: ... $$$`)
  and runs an extra pragma query to produce that line.
- The `profiles` table holds **6 rows all named "Matteo"** — the known duplicate-profile
  bug, unrelated to performance except that it makes the gallery's `creator_avatar_url`
  subquery scan.

## Checked and ruled out — do not spend effort here

- **The read path.** See the top of this document; re-measured this pass.
- **A stale Electron build.** `dist/` was rebuilt the same day the symptom was reported, so
  the running app does include the Sep-12 fixes.
- **Fonts.** Material Symbols is a locally-subset 260 KB woff2, bundled — no network fetch,
  no FOIT.
- **Locale JSONs.** All four are bundled and parsed at startup, but they total ~156 KB, not
  the several hundred KB the previous plan's P2 implied. Lazy-loading them is still tidy,
  but it is not a fix for this symptom.
- **Missing indexes.** Re-confirmed from the Sep-12 pass; unchanged.

## Suggested order

1. ~~WAL + `synchronous=NORMAL`~~ — **done**; ~40× on every write, both platforms.
2. ~~`listTools()` batching~~ — **done**; 31 round-trips → 2.
3. Batch the per-row write loops (`updateRecipe`, `conflicts.local.ts`'s merge-apply,
   `backup.local.ts`'s restore) into `executeSet` so a save is one transaction rather than
   36 — compounding with item 1, and the last big write-side win.
4. Confirm the fetch-negotiation hypothesis, then cap and consolidate the packfiles.
5. Skip `statusMatrix` when nothing changed; back off the resume sync.
6. `VACUUM` once; thumbnails; drop the `Response`/`res.json()` round trip; `Home.tsx`
   memoization.

---

## What shipped (2026-09-13)

- **`applyWriteJournalPragmas()`** in `db/local.ts`, applied once per connection in
  `getDb()`. Failure is warned and swallowed rather than thrown — this runs inside the one
  code path every screen depends on, so a platform that refuses a pragma keeps the old slow
  behaviour instead of failing to open the database at all.
- **`listTools()`** batched, matching the other four catalog lists exactly.
- Regression tests for both: `db/local.test.ts` asserts the pragmas are issued *and* that
  they are issued unwrapped (`transaction: false`), which is the half that silently does
  nothing if it regresses; `catalog-lists.local.integration.test.ts` gains a `listTools`
  block pinning it at 2 queries for a 30-tool catalog, alongside the behavioural cases
  (requested language, full per-language array, JSON array columns, search filter).

562 tests pass, typecheck clean.
