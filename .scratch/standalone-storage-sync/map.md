## Destination

Every remaining technical and UI/UX decision needed before SmartChef's standalone-mode storage/sync redesign ([Split standalone-mode storage: user-chosen local storage + Syncthing-friendly git sync folder](https://github.com/MGriot/smartchef/issues/4)) can be built with confidence is resolved and recorded. No new consolidated document is required — an implementer reads issue #4 plus this map's Decisions-so-far to build.

## Notes

Domain: see [CONTEXT.md](../../CONTEXT.md) and [ADR 0001](../../docs/adr/0001-bare-remote-sync-folder-structured-merge.md) for the settled vocabulary and architecture rationale this effort builds on. Every `grilling`-type ticket should also consult the `domain-modeling` skill, per wayfinder's default.

Sequencing preference (from the user): data-model and merge-mechanics decisions before UI/UX decisions. UI/UX questions stay in Not yet specified until there's something concrete to design against, rather than being ticketed up front.

## Decisions so far

- [Research isomorphic-git's remote capabilities](issues/01-isomorphic-git-remote-capabilities.md) — isomorphic-git's fetch/push/pull are hard-locked to http(s) transport (confirmed in source + upstream issue); the Hidden Clone must reach the Sync Folder via hand-rolled object/ref plumbing (the same approach `androidMirror.ts` already uses), not literal `git.fetch`/`git.push`, on both Electron and Android. `findMergeBase`/`walk`/`readBlob` are usable for the common-ancestor step; Structured Merge's field-level JSON combine has no library equivalent and must be hand-written.
- [Nested merge policy](issues/02-nested-merge-policy.md) — recipe steps/ingredients/tools each merge as one whole-array field (value-compared against the common ancestor, not per-row), independently of each other and of scalar fields. No schema changes needed. Deliberate simplicity-over-precision trade-off — see [ADR 0002](../../docs/adr/0002-whole-array-merge-for-nested-recipe-collections.md).
- [Hidden Clone lifecycle](issues/03-hidden-clone-lifecycle.md) — created lazily (only when a Sync Folder is first configured), lives at a platform-specific private subfolder distinct from Local Storage (`userData/sync-clone` on Electron, `Directory.Data/sync-clone` on Android), carries full-resolution images (not recompressed — see [ADR 0003](../../docs/adr/0003-hidden-clone-full-resolution-images.md)), pushes only entities changed since the device's own last sync, and has a "Reset Sync" recovery action (re-clone from Sync Folder, fresh init as last resort).
- [Conflict data model](issues/04-conflict-data-model.md) — one generic `sync_conflicts`-style table (entity_type, entity_id, field_name, base/local/remote values) covers every entity and field uniformly; conflicted fields keep showing the local value untouched until resolved; repeated syncs upsert rather than duplicate; resolving just writes the value and rides the next normal sync; ancestor value comes from git history at merge time, not a separate table.
- [Image storage & dedup format](issues/05-image-storage-dedup-format.md) — images render via `Capacitor.convertFileSrc()` against a relative, content-addressed path; Local Storage stores images content-addressed from the moment they're added (same convention everywhere); push/pull copies a file only if it's missing at the destination; no garbage collection for orphaned images (accepted accumulation, matching the existing git-object precedent).
- [Conflicts list UI](issues/06-conflicts-list-ui.md) — entity-grouped layout (Variant C: field-chips per affected entity) won over inline-flat and badge+dedicated-page alternatives; whole-array field conflicts (steps/ingredients/tools) show a real red/green line diff instead of a count, display-only, doesn't reopen ADR 0002. Prototype captured on branch `prototype/conflicts-list-ui`, not merged — folding into production is future implementation work.
- [Account creation flow](issues/07-account-creation-flow.md) — combined single-screen layout (Variant A) won: name field + an inline, clearly skippable "Sync across your devices" card, same treatment on both platforms (fixes today's Electron-only asymmetric prompt). Prototype captured on branch `prototype/account-creation-flow`, not merged — folding into `ServerConnect.tsx`/`lib/standalone.ts` is future implementation work.

## Not yet specified

- UI/UX: first-run migration prompt — silent auto-import of the existing backup snapshot vs. a confirm step.
- UI/UX: folder-picker copy/flow for Electron vs. Android under the new engine.
- Sync Engine implementation specifics that ticket 01's answer opens up but doesn't itself resolve: the exact shape of the hand-rolled push/pull plumbing (object upload/skip rules, ref update ordering) for the new topology, and where the Structured Merge field-combine logic actually lives (standalone module vs. a custom isomorphic-git `mergeDriver`). Likely graduates alongside or after ticket 03 (Hidden Clone lifecycle).

## Out of scope

- Server (Postgres-backed) mode — unaffected by this effort.
- iOS.
- Hosted-DB standalone sync mode (separate, not-yet-started effort per the superseded folder-sync-parity docs).
