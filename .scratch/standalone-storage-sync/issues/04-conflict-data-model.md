Type: grilling
Blocked by: 02
Status: resolved

## Question

Design the schema for tracking a pending Conflict in Local Storage: which entity/fields are involved, how both versions' values and the common-ancestor values are stored, how a Conflict record is created during a sync cycle and cleared once the user picks a version, and how the (fogged, not-yet-ticketed) Conflicts list UI will query "all pending conflicts."

Granularity depends on ticket 02's nested-merge-policy answer — e.g. if child-row-level conflicts are possible, does one Conflict record cover a whole recipe or one specific child row?

## Answer

- **Schema**: one generic table (e.g. `sync_conflicts`: entity_type, entity_id, field_name, base_value, local_value, remote_value, detected_at) covers every entity type and every conflictable field uniformly — scalar fields and the three whole-array recipe fields (per ticket 02) alike. No per-entity-type variants.
- **Live value while pending**: the conflicted field keeps showing this device's own local value, untouched, in Local Storage until the user resolves it. The entity's other, non-conflicting fields still merge and apply normally around it.
- **Repeated sync before resolution**: upserts the existing pending conflict record (refreshing `remote_value`/`base_value` to latest) rather than creating duplicates — one live conflict per (entity, field) at a time.
- **Resolution**: picking a version writes the chosen value into Local Storage and marks the conflict resolved (or deletes the row). No dedicated immediate-push path — the write bumps the entity's `updated_at`, so it rides the next normal automatic sync/push per ticket 03's dirty-tracking.
- **Ancestor value**: sourced transiently from git history via `findMergeBase` at merge time and copied into `base_value` for reference — no separate persistent "last synced snapshot" table in Local Storage.
