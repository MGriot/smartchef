Type: grilling
Status: resolved

## Question

What is the Structured Merge policy for an entity's nested child collections — recipe steps, recipe ingredients, and recipe-tool associations — which are normalized child rows in Local Storage but presumably serialized as arrays within a recipe's entity JSON in the Sync Folder?

Concretely:

- When one device reorders steps and another device adds a new step to the same recipe before either syncs, what's the merge outcome?
- When one device edits a specific ingredient line's quantity and another device deletes that same recipe_ingredient row, is that a Conflict, or an auto-resolved delete-wins/edit-wins?
- Does merge operate per-child-row keyed by stable id (each row's own id/updated_at compared independently), or at the whole-array level (any array difference at all is a Conflict)?

This determines both the granularity of what becomes a Conflict (feeds ticket 04) and what Structured Merge actually has to implement per entity type.

## Answer

**Granularity: whole-array, not per-row.** Each of `steps`, `ingredients`, `tools` is compared as a single JSON value against the common ancestor — not diffed element-by-element, no per-row identity or timestamps needed.

**Merge outcome**: if only one device changed a given array since the ancestor, that side's version applies cleanly (fast-forward). If both devices changed the *same* array since the ancestor — a reorder, an add, an edit, or a delete of any row within it, it doesn't matter which — that's one Conflict on that array, surfaced to the user per the existing Conflict UX (non-blocking; the rest of the recipe's other fields still merge independently).

**Field independence**: `steps`, `ingredients`, and `tools` are three independent fields, each with its own conflict fate — consistent with how scalar fields (title, description, etc.) already merge independently at the entity level. A single recipe can have 0–3 simultaneous pending conflicts across its nested collections, plus any scalar-field conflicts.

**No schema changes required**: no new `updated_at`/`deleted_at`/id columns on `recipe_steps`, `recipe_ingredients`, or `recipe_tools`. Whole-array comparison works off the existing write path, which already rewrites a recipe's full nested structure as one unit on any child mutation — this was confirmed as the deciding practical factor, alongside deliberately trading merge precision for implementation simplicity (see ADR 0002).

This was a deliberate choice against the recommended per-row alternative — see [ADR 0002](../../../docs/adr/0002-whole-array-merge-for-nested-recipe-collections.md) for the trade-off.

**Implementation-time addition**: the "it doesn't matter which [operation]... that's one Conflict" wording above is slightly stricter than what `frontend/src/lib/structuredMerge.ts`'s `mergeField()` actually does — if both sides changed a field (scalar or whole-array) and independently landed on the *exact same resulting value* (deep-equal), that's treated as `unchanged`, not a Conflict. There's genuinely nothing to reconcile in that case — surfacing a conflict the user would just click "same value" on twice adds friction with no value. This applies uniformly to scalar and whole-array fields alike, so it doesn't reopen the whole-array-vs-per-row granularity decision above, just narrows what counts as a genuine conflict within that granularity.
