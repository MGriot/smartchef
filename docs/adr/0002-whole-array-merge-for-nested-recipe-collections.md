---
Status: accepted
---

# Whole-array merge granularity for nested recipe collections

**Context**: A recipe's steps, ingredients, and tool associations are normalized child rows in Local Storage but serialize as arrays within the recipe's entity JSON in the Sync Folder. Structured Merge (ADR 0001) needed a policy for these arrays specifically: merge per-child-row (keyed by stable id, needing new `updated_at`/`deleted_at` columns on `recipe_steps`/`recipe_ingredients` and an identity convention for `recipe_tools`, which has none today), or treat each array as one opaque field.

**Decision**: Each of `steps`, `ingredients`, `tools` is merged as a single whole-array field, compared by value against the common ancestor — not decomposed row-by-row. If only one device changed a given array since the ancestor, it fast-forwards; if both changed it (reorder, add, edit, or delete of any row — all treated alike), the whole array is one Conflict, surfaced to the user like any other field-level conflict. The three arrays remain independent of each other and of scalar fields (title, description, etc.), so a conflict on `steps` doesn't block `ingredients` or `title` from merging.

**Considered options**: per-row keyed merge (rejected — requires schema additions across three tables, including inventing an identity convention for `recipe_tools`, for a precision gain the user judged not worth the cost at this stage).

**Consequences**: Two devices editing *different* steps of the same recipe concurrently will conflict under this policy, where per-row merge would have combined them silently — a known, deliberate trade-off of simplicity over merge precision. No schema migration is needed for `recipe_steps`, `recipe_ingredients`, or `recipe_tools`; the existing write path (which already rewrites a recipe's full nested structure as one unit on any child mutation) is sufficient. Full history at [issue #4](https://github.com/MGriot/smartchef/issues/4) and [wayfinder ticket 02](../../.scratch/standalone-storage-sync/issues/02-nested-merge-policy.md).
