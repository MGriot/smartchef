Type: prototype
Status: resolved

## Question

Design and prototype the Conflicts list UI: where it lives (extending `Account.tsx`/`SyncHistory.tsx`'s existing sync-status surface, or somewhere new), what's shown per pending conflict (entity name/type, which field, a preview of the local vs. remote value), how the passive badge/banner (matching the existing "sync paused" pattern) surfaces that pending conflicts exist without interrupting the user, and the "pick a version" interaction itself — a simple mine/theirs choice, or a fuller side-by-side comparison.

Now buildable concretely: ticket 04 (Conflict data model) settled the underlying data every pending conflict carries — entity_type, entity_id, field_name, base_value, local_value, remote_value — so this ticket is about presentation, not schema.

## Answer

Three structurally different variants were prototyped live on the real `/account` route (mounted above `FolderSyncCard`, switchable via `?variant=`) with mock data matching ticket 04's schema:

- **A — Inline expand**: a passive amber banner (matching the existing "sync paused" style) that expands in place into a flat list, one row per field-conflict.
- **B — Badge + full comparison**: a small "N Conflicts" pill (matching the existing enabled/disabled status pill), opening expandable cards with a real two-column local-vs-remote comparison and the ancestor value shown for context.
- **C — Entity-grouped**: leads with which entity is affected first (e.g. "Grandma's Lasagna — 2 conflicts"), with a field-chip per conflicting field inside the card, so one entity's multiple simultaneous conflicts (per ticket 04's per-field granularity) stay together instead of fragmenting across separate list rows.

**Winner: Variant C**, with one addition — for whole-array fields (steps/ingredients/tools, per ADR 0002), the flat "N items vs M items" summary is replaced with a real line-level diff: an LCS-based comparison between the local and remote arrays, rendered with a git-diff-style red/`−` (only in mine) and green/`+` (only in theirs) treatment, unchanged lines shown plain. This is **display-only** — it does not change the whole-array merge policy or reopen ADR 0002's "no per-row identity" decision; it purely helps the user judge which version to keep when resolving a conflict on an array field.

Prototype captured on throwaway branch `prototype/conflicts-list-ui` (commit `b430f70`), not merged to main — three variant components, a switcher, mock data, and the LCS diff utility. Folding the winning design into production `Account.tsx`/a real Conflicts component is implementation work for later, out of scope for this decision-only wayfinder ticket.
