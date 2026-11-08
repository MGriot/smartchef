# SmartChef — Codebase Cleanup Audit (2026-10-22)

## Context
A cleanup audit (`/codebase-cleanup-audit`) covering duplicated, obsolete, redundant and unoptimized code. Everything in this report is read-only. **No change happens until you approve findings by ID.** After approval, each batch below goes on a new branch with one commit per finding.

---

## 1. Executive summary

**15 findings:** 1 × P1, 6 × P2, 8 × P3. By category: OBS (obsolete/dead) 8, DUP (duplication) 5, RED (redundant) 1, PERF 1.

Overall the code is clean. jscpd measures only **1.44 % duplicated lines** (50 clones), and most of that is the deliberate server/standalone dual implementation. The one serious finding is a security issue hiding inside dead code.

**Top 5 quick wins**
1. **OBS-01** (P1): remove the legacy CRDT/mDNS peer-sync. It is inert as a feature, but `POST /api/sync/receive` is mounted **before `requireAuth`**, so anyone can upsert recipes and delete menus or shopping lists without logging in.
2. **OBS-02**: delete `frontend/src/services/api.ts`, an API client that nothing imports and that has been untouched since the first commit.
3. **OBS-04**: drop 4 unused frontend dependencies (`clsx`, `date-fns`, `lucide-react`, `react-query`) and the redundant `@types/bcryptjs`.
4. **OBS-06**: remove the unused locals and imports that `tsc --noUnusedLocals` reports (6 frontend, 1 backend).
5. **DUP-01**: `parseJsonObject` is copied verbatim into two LLM services. Move it into `llmParser.local.ts`, next to `repairTruncatedJson`.

**Main risks**
- OBS-01 changes what the public API exposes. If anyone runs two backends doing peer-sync, it stops. Per your docs it never actually transferred local edits, so the real exposure is nil.
- Removing code or comments can change the shipped icon font, because the subset script also scans prose. After each batch, check `git diff frontend/src/fonts/`.
- Other sessions edit this checkout, and line numbers have already moved during the audit. Each batch re-greps before editing.

---

## 2. Scope and methodology
- **In scope:** `frontend/src`, `frontend/electron/src`, `frontend/convert-theme.js`, `backend/src`, `mcp/src`, `shared/`.
- **Excluded:** `db/migrations`, `fastlane`, generated Android code, Android build output, `docs`, `.scratch`, the contents of the locale JSON files, fonts, and binary assets.
- **Tools** (all read-only, output saved to the session scratchpad):
  - `tsc --noEmit --noUnusedLocals --noUnusedParameters` (TS 5.x) on frontend, backend and mcp
  - `knip@5` per package, run via npx with no fix flags
  - `jscpd@4` with min 8 lines / 70 tokens; tests, JSON and CSS excluded
- Every lead was verified by hand: grep for references (including dynamic `import()` and string routes), `git log` for history, and reading the code.
- **Baseline tests:** frontend vitest gives **1187 / 1188 pass**. The failure is `pdfText.test.ts`, which timed out at 5 s under full-suite load and passes on its own in 1.5 s. It is flaky, not broken. Backend and mcp have no tests; CI only typechecks them.
- **Known blind spots**
  - knip can't see `frontend/electron` (a separate package) or `probe.tsx` (a `probe.html` entry). Both are used, so they're excluded from the findings.
  - Backend `src/scripts/*` are hand-run CLI scripts, so they're kept.
  - No profiler data exists. No performance claim here is backed by a measurement.

---

## 3. Findings

### Obsolete / dead code (OBS)

| ID | Location | Description and evidence | Proposed change | Impact | Effort | Risk | Conf | Prio |
|---|---|---|---|---|---|---|---|---|
| OBS-01 | `backend/src/routes/sync.ts` (all), `backend/src/services/mdns.service.ts` (all), `backend/src/services/crdt/vector-clock.ts` (all), `backend/src/index.ts:30,64-68,125-128` | **Legacy CRDT/mDNS P2P sync: dead as a feature, live as an attack surface.** `appendOperation` is only called from `applyRemoteOperation`, so local edits never produce operations. There is no mDNS library in the deps. The only client is the dead `services/api.ts:86`. `docs/status.md:68` already calls it "Legacy, inert". **But** the router is mounted before `requireAuth`, and `POST /receive` runs `INSERT … ON CONFLICT DO UPDATE` on `recipes` and `DELETE FROM menus` / `DELETE FROM shopping_lists` for any payload. `/handshake` lets anyone register a peer, and `/trigger/:id` makes the server fetch it. 6 of the 10 vector-clock exports have no callers. The 2026-10-17 audit missed this. | Delete the 3 files, remove the mount and `startSyncLoop` from `index.ts`, and remove the `CRDTOperation` type if it becomes unused. Keep the DB tables (no migration). Update `docs/architecture.md:139`, `docs/standalone-sync.md:24` and `docs/status.md:68`. | Security, ~450 LOC | S | Med (removes a public endpoint) | High | **P1** |
| OBS-02 | `frontend/src/services/api.ts` (90 lines) | Old fetch client (`recipesApi`, `sync.peers`, …). It has zero importers (verified, including `../services/api` paths) and is unchanged since `d051eb0` (initial commit). The live client is `lib/api.ts`. | Delete the file. | Maintainability | S | Low | High | P2 |
| OBS-03 | `frontend/convert-theme.js` | One-shot script that rewrites hex colours in `theme.css` to RGB triplets. It has already been applied (`theme.css:2` is `0 108 73`). It's unreferenced and from the initial commit. | Delete the file. | Maintainability | S | Low | High | P2 |
| OBS-04 | `frontend/package.json` and `backend/package.json` | Unused dependencies, each with **0** references in src, config or scripts: `clsx`, `date-fns`, `lucide-react`, `react-query` (frontend). `@types/bcryptjs` is redundant because bcryptjs 3.0.3 ships `index.d.ts`. *Kept as false positives:* `buffer` (polyfill in `main.tsx`), `material-symbols` (read by the subset script), `@capacitor-community/electron` (`cap sync`), `@capacitor/assets` (manual icon CLI; see Q2). | Remove them with `npm uninstall`, which updates the lockfiles. | Install size, supply chain | S | Low | High | P2 |
| OBS-05 | `frontend/src/i18n/index.ts:11` `SUPPORTED_LANGUAGES`; `lib/llmMedia.ts:60` `KIND_LABEL`; `lib/localImages.ts:~270` `forgetResolvedImageSrc`; `lib/offlineStore.ts:107` `hasCachedData`; `lib/sync/syncSettings.ts:~274` `hasSyncIntervalOverride`; `services/syncReconcile.local.ts:294` `forgetStuckEntity`; `lib/sync/testUtils/fakes.ts:89` `putBytes` | Exports whose only mention anywhere in `frontend/src`, tests included, is the declaration itself (`git grep -w` count is 1). | Delete them. | Maintainability | S | Low | Med-High (string dispatch was checked; none found) | P2 |
| OBS-06 | `pages/Account.tsx:2394` `custom`; `pages/Planner.tsx:22` `EventMealType`; `pages/RecipeCreate.tsx:17` (entire import unused); `pages/RecipeImport.tsx:8` `languageLabel`; `components/ConverterPanel.tsx:7` `fahrenheitToCelsius`; `pages/ShoppingList.tsx:61` `setListName`; `backend/src/services/ingredient.matcher.ts:12` `DBUnit` | Unused locals and imports reported by `tsc --noUnusedLocals`. `listName` is never set, so it's always `''`: the name input was removed but its state stayed. | Remove them. Replace the `listName` state with the fallback it already uses. | Readability | S | Low | High | P2 |
| OBS-07 | 21 files, line 1 (e.g. `components/AtlasMap.tsx`, `pages/ShoppingList.tsx`) | `import React from 'react'` is unused under `jsx: react-jsx`. It's cosmetic only. | Remove the default import and keep the named ones. | Readability | S | Low | High | P3 |
| OBS-08 | `frontend/tsconfig.json`, `backend/tsconfig.json` | Nothing prevents OBS-05/06/07 from coming back; the repo has no linter (see the earlier audit, item 12). | After OBS-06 and OBS-07, enable `noUnusedLocals` (not `noUnusedParameters`). CI then enforces it via `tsc --noEmit`. | Prevention | S | Low | High | P3 |

### Duplicated code (DUP)

| ID | Location | Description and evidence | Proposed change | Impact | Effort | Risk | Conf | Prio |
|---|---|---|---|---|---|---|---|---|
| DUP-01 | `frontend/src/services/aiTasks.local.ts:18-26`, `services/recipeCheck.local.ts:22-30` | `parseJsonObject` is an **exact** clone (13 lines). Both copies wrap `repairTruncatedJson` from `llmParser.local.ts`. | Export one `parseJsonObject` from `llmParser.local.ts` and import it in both places. | Maintainability | S | Low | High | P2 |
| DUP-02 | `pages/LibraryTools.tsx` vs `pages/LibraryTechniques.tsx` (7 clone blocks, ~150 lines: list rows, edit modal, merge dialog; e.g. Tools 282-316 / Techniques 270-304, Tools 345-383 / Techniques 323-360) | **Near-duplicate** pages. **All 11 commits** to LibraryTechniques also touched LibraryTools, so the copies change together. `LibraryTags.tsx` shares 3 more blocks, which makes 3 copies (rule of three met). | Extract the shared edit-modal and merge-dialog pieces into `components/` and parameterise them by entity (icons, endpoint, i18n keys). Leave the page shells alone. | Maintainability | M | Med (UI behaviour) | Med | P3 |
| DUP-03 | `pages/Login.tsx:189-238` (first-run setup form) vs `:332-371` (register form) | **Renamed clone**: same fields, different handler and labels. | Extract an `<AccountFields>` component used by both forms. | Maintainability | S | Low-Med | Med | P3 |
| DUP-04 | `backend/src/routes/ingredients.ts:179` (tools), `routes/tags.ts:25`, `routes/techniques.ts:14` | The same "list with `lang`/`q` filters plus an aggregated translations JSON" handler appears 3 times (14-line clones). Backend only. | Add a small helper (`listWithTranslations(table, trTable, fk)`) or leave it as is. Server mode only, so the value is low. | Maintainability | S | Low | Med | P3 |
| DUP-05 | `frontend/src/services/matrioska.local.ts` ↔ `backend/src/services/matrioska.engine.ts` (~200 lines in 7 blocks); also importCatalog, pantry, shopping, tags, share and nutrition pairs | **Deliberate port.** The header says "Ported … unchanged except query()". It's co-edited in the same commits (`a6c3220`, `82e9a55`, `085d7e7`) and **already drifting**: only the frontend has per-section `techniques` and `groupName`, and the `is_optional` type differs. | **Report only, no change now.** Unifying would need `shared/` wired into the Vite build and an injected `query`, which is L effort and High risk. See Q3. | Correctness drift | L | High | High (that it is duplicated) | P3 |

### Redundant code (RED)

| ID | Location | Description and evidence | Proposed change | Impact | Effort | Risk | Conf | Prio |
|---|---|---|---|---|---|---|---|---|
| RED-01 | `backend/src/services/mdns.service.ts:12` `MDNS_SERVICE_TYPE`, `routes/sync.ts:11` `SyncHandshake` | Unused constant and type import. Both are inside OBS-01. | Goes away with OBS-01. If OBS-01 is rejected, delete just these two lines. | — | S | Low | High | P3 |

### Unoptimized code (PERF)

No hot-path problem was found with concrete evidence. The loops that write to SQLite one row at a time (`tags.local.ts`, `techniques.local.ts`, `ingredients.local.ts` merge/delete helpers) filter first, and only run on rare library-maintenance actions.

| ID | Location | Description and evidence | Proposed change | Impact | Effort | Risk | Conf | Prio |
|---|---|---|---|---|---|---|---|---|
| PERF-01 | `frontend/src/services/tags.local.ts:174` `removeTagNameFromRecipes` | Reads `id, tags` for **every** non-deleted recipe and filters in JS. On Android each row crosses the Capacitor bridge (see the memory note on bridge cost). It only runs on tag delete. | Pre-filter in SQL with `WHERE tags LIKE $1` (case-insensitive `%name%`) and keep the exact JS check. | Perf on Android, rare path | S | Low | **Low** (not measured) | P3 |

---

## 4. Proposed execution plan (safest first; one branch, one commit per ID)
Branch: `chore/cleanup-audit-2026-10`. Re-grep every symbol before editing, because other sessions share this tree. No `git stash`.

1. **Batch A, dead files and dependencies:** OBS-02, OBS-03, OBS-04.
2. **Batch B, dead symbols:** OBS-05, OBS-06, OBS-07, then OBS-08 (the tsconfig flag must go last).
3. **Batch C, security and dead backend feature:** OBS-01 (+RED-01) and the doc updates. Separate commit and easy to revert.
4. **Batch D, small dedupe:** DUP-01, DUP-03, DUP-04.
5. **Batch E, larger refactor (only if approved):** DUP-02, PERF-01.
6. DUP-05 has no action in this round.

## 5. Verification plan
- **After every batch:** `npx tsc --noEmit` in `frontend`, `backend` and `mcp`; `npm test` in `frontend` (expect 1188 passing, with the known flaky `pdfText` timeout rerun alone if it trips); `npm run build` in `frontend` (catches dynamic-import breakage); `git diff frontend/src/fonts/` (icon subset drift).
- **OBS-04:** `npm ci` from a clean lockfile, then a build.
- **OBS-01:** backend boots (`tsc`, then `node dist/index.js` against the dev DB if one is available). `POST /api/sync/receive` returns 404 or 401. No frontend reference to `/api/sync/` remains (excluding `sync-folder`).
- **DUP-02 / DUP-03:** there's no jsdom in the suite, so add characterization coverage first or verify through a probe page / dev server (see the memory note). Before/after screenshots of Tools, Techniques and Tags editing; Login setup and register.
- **PERF-01:** add a unit test for tag delete that covers case-insensitive matching before changing the SQL.
- **Rollback:** each ID is its own commit, so `git revert <sha>`.

## 6. Open questions
- **Q1 (OBS-01):** Does any self-hosted deployment rely on `/api/sync/*` between two backends? The docs say it never transferred local edits. Should I remove it, or only move it behind `requireAuth` for now?
- **Q2 (OBS-04):** Do you run `npx capacitor-assets` to regenerate icons and splash screens? If yes, keep `@capacitor/assets`; it's already excluded above.
- **Q3 (DUP-05):** Long term, do you want one engine shared between server and standalone (wire `shared/` into the frontend build), or is the backend heading for maintenance-only status? That decides whether the drift matters.

## 7. Approval checklist
- [x] OBS-01 (P1) — remove the unauthenticated legacy CRDT/mDNS sync
- [x] OBS-02 — delete `services/api.ts`
- [x] OBS-03 — delete `convert-theme.js`
- [x] OBS-04 — drop 4 unused frontend deps and `@types/bcryptjs`
- [x] OBS-05 — delete 7 dead exports
- [x] OBS-06 — remove unused locals and imports (incl. `listName` state)
- [x] OBS-07 — remove 21 unused `React` default imports
- [x] OBS-08 — enable `noUnusedLocals`
- [x] DUP-01 — share `parseJsonObject`
- [x] DUP-02 — extract shared Tools/Techniques/Tags editor pieces
- [x] DUP-03 — `<AccountFields>` in `Login.tsx`
- [x] DUP-04 — backend list-with-translations helper
- [ ] DUP-05 — report only (no change)
- [x] RED-01 — only if OBS-01 is rejected
- [x] PERF-01 — SQL pre-filter for tag delete

## 8. Outcome (2026-10-25)
All findings except DUP-05 (report only) were applied on `chore/cleanup-audit-2026-10`, one commit per ID. Quick wins were approved 2026-10-24, the rest 2026-10-25. Afterwards the frontend has 1192 passing tests (4 new), all three packages typecheck with `noUnusedLocals`, and the icon subset is unchanged.

Where the work differed from the plan above:
- **OBS-01:** RED-01 went away with it. Booting the backend confirmed `/api/sync/*` now reaches `requireAuth`. The `crdt_operations` table and `crdt_clock` columns stay.
- **OBS-04:** removing `react-query` also dropped 14 packages only it depended on.
- **OBS-05:** `getCacheTimestamp` was removed as well; its only caller was `hasCachedData`.
- **OBS-07:** 23 files, not 21 (`probe.tsx` and one more).
- **DUP-02:** grew into `components/LibraryCatalog.tsx` and `hooks/useCatalogMerge.ts`. Tags keeps its own merge handler, because it also merges free-text tags. A probe page showed the markup byte-identical to before.
- **DUP-03:** done as a shared JSX fragment rather than a separate component, matching the page's existing `avatarField`. The markup is identical to before.
- **DUP-04:** became `services/catalogList.service.ts`. Its SQL text and params are byte-identical to the old handlers for every `lang`/`q` combination.
- **PERF-01:** the plain `LIKE` pre-filter proposed above was wrong. SQLite's `LIKE` does not fold accented capitals, so deleting "été" would have left "Été" on recipes. The pre-filter now only applies to plain-ASCII names without `"` or `\`; other names keep the full read.

New observation for a later round: `parseJsonResponse` in `frontend/src/services/llmParser.local.ts` repeats the JSON-extraction lines that DUP-01 shared.
