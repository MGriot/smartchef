---
Status: accepted
---

# Real merge commits, normalized comparison, and "newest wins" by default

**Context**: Two devices syncing the same library produced a Conflicts card with 79 items, sync after sync. Most were not real disagreements:
- one side empty and the other filled in;
- steps identical except for row ids;
- tags in a different order.

Where a field genuinely differed, the card showed raw JSON and file names. The user asked for the sync to behave like git: merge on its own, let the most recent edit win, and ask only when there is no obvious answer or they opt in.

Four causes, found by reading the engine and then reproducing it with two real devices (`lib/sync/twoDevice.sync.integration.test.ts`):

1. **No common ancestor, ever.** After a merge, `gitSync.ts` committed with a single parent — the device's own previous commit. The remote commit it had just reconciled never became an ancestor. So `findMergeBase()` found nothing between two devices, and every Structured Merge compared against an empty base, which is a two-way diff. Every field that differed became a Conflict. This is also why git-remote pushes needed `force: true` (ADR 0004's second update). The mocked `findMergeBase` in `mergeBridge.test.ts` hid it.
2. **Serialization noise compared as edits.**
   - Child rows carry their own `id`, `recipe_id` and `created_at`. `updateRecipe()` regenerates the ids on every save, and a synced-in row gets the receiving device's insert time.
   - Rows were serialized with no `ORDER BY`.
   - JSON columns (`tags`, `regions`, …) were compared as raw strings.
   - `null`, `""` and a missing key counted as three different values.
3. **Per-device ids in synced data.** Ingredient categories and units are per-device seed rows with random ids (see `db/local.ts`). A synced ingredient's `category_id` never matched locally, so it landed in "Uncategorized" and every category showed 0. Recipe ingredient `unit_id`s never matched either.
4. **Stale Conflict rows.** `upsertConflict` pinned the local side at first detection, and nothing ever cleared a row the next merge found settled.

**Decision**:

- **Merge commits have two parents** — `[local HEAD, remote]`, via `commitMergeInternal()`. One is written after every merge, even when no file changed. The next merge's base is then the commit already reconciled, so only edits made since then are compared. A merge whose remote is already an ancestor (`isDescendent`) is skipped. Every file the remote tree has and the working tree lacks is copied in before committing (`copyRemoteOnlyFiles()`). Once the remote is an ancestor, a missing file would read as a deletion.
- **Values are compared after normalization** (`lib/mergeNormalize.ts`), for equality only; the value written is always one of the raw sides:
  - JSON strings are parsed;
  - every spelling of "empty" is the same;
  - text is trimmed and CRLF→LF;
  - set fields are compared as sets;
  - child rows lose their per-device bookkeeping and are ordered by `step_number` / `sort_order`;
  - recipe ingredients compare units by symbol.

  The serializers now write `ORDER BY` and carry `unit_symbol` and `category_name`. Ingredients merge on `category_name`, which `resolveCategoryIdByName()` maps to this device's own category, creating it if needed. Recipe ingredient rows map `unit_symbol` back to a local unit. A one-time re-serialize after upgrade brings existing files up to date.
- **Rules settle what has an obvious answer** (`structuredMerge.ts`):
  - with no ancestor, an empty side takes the other side;
  - set fields (tags, regions, photos, seasonal months, tools, synonyms) merge member by member — keep what either side added, drop what either removed.
- **The Conflict Policy decides real disagreements** (`syncSettings.ts`, `smartchef.sync.conflictPolicy`):
  - `newest` (the default) keeps the side whose entity `updated_at` is later;
  - `ask` records a Conflict.

  Even under `newest`, a disagreement is still asked about when timestamps are missing or equal. A merge now stamps the row with the later of the two edit times rather than `now()`, so "newest" keeps meaning "last edited", not "last synced".
- **Pending Conflicts stay git-correct.**
  - While a field waits on the user, it is committed with the **remote** value (`overlayPendingConflicts()`). Otherwise the other device would fast-forward to this device's side before anyone chose it. Picking "mine" rewrites the file with the local value, which then travels as an ordinary edit.
  - The merge reads the pending row's local value, not the tree's.
  - Both sides of a row are refreshed on every re-detection. A row the next merge finds settled is deleted.
  - After each sync, `autoResolvePendingConflicts()` applies the same rules to whatever is pending, which clears the backlog recorded before this ADR.
- **Replace from synced data** (`replaceLocalWithRemote()`) is the explicit `git reset --hard`. It takes the remote as the truth for this device's library:
  - it reads everything first and aborts on any unreadable file;
  - it keeps a backup ref under `refs/backups/`;
  - it overwrites synced rows in place and discards local-only ones, keeping cooking history, collections, planner and settings;
  - it moves the Hidden Clone onto the remote commit.

- **The whole library syncs, not just the rows.** Each entity file now embeds what the entity owns:
  - `translations` (keyed by `lang`) on every type;
  - step and ingredient-row translations inside a recipe's `steps`/`ingredients`;
  - an ingredient's `tag_ids`;
  - a tag's `group_translations`;
  - the ingredient fields `synonyms`, `plural_name` and `parent_ingredient_id`.

  Translations merge per language, so two devices adding different languages never conflict. Ingredient **categories and units** are synced entity types on **portable ids**: `cat-<name-slug>` and `unit-<symbol-slug>` (`services/syncExtras.local.ts`). `db/local.ts` `rekeyPortableIds()` moves existing rows onto those ids once, so the same "Frutta" is the same row on every device. A format version (`smartchef.sync.reserializedFormat`) re-serializes the library once after upgrading. Merge order is categories, units, tags, tools, techniques, ingredients (base ingredients before their varieties), profiles, then recipes.
- **Commits never miss a write.** `writeEntityFile()` records each written path, and the commit stages those paths explicitly. Otherwise `statusMatrix()`'s stat cache (size + mtime seconds) misses a same-size rewrite made within a second of the previous one.

**Supersedes**: ADR 0001's "a Conflict is never auto-resolved". That rule assumed Conflicts would be rare and real. Because of cause 1 they were neither, and the user explicitly asked for last-edit-wins with asking as an option. ADR 0002 (whole-array steps/ingredients) still stands for merging; the Conflicts card now shows those arrays aligned item by item for display.

**Consequences**:
- Under `newest`, a concurrent edit to the same field on two devices silently keeps the later one. That is the stated wish, and the sync result reports how many fields were settled this way.
- Device clocks matter a little: a device with a clock far in the future would win ties it shouldn't.
- `force: true` on git-remote pushes is now redundant. It is kept for one release as a safety net.
- Deletions are still not propagated for recipes and ingredients. `sync_status` is not a merged field, contrary to the Deletion Marker entry in CONTEXT.md. `replaceLocalWithRemote()` honours it, but the ordinary merge does not; this is tracked separately.
