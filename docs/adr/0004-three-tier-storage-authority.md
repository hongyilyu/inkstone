# Storage authority: SQLite is the single source of truth

> **Note on filename.** The slug is historical. Inkstone has **two** tiers; the file is kept at `0004-three-tier-storage-authority.md` to preserve inbound ADR links.

Inkstone has two persistence tiers, both in SQLite. Tier 2 is authoritative for everything Core durably owns — content **and** application state. Tier 3 is derived: re-derivable indexes and views, authoritative for nothing. In practice the schema today is effectively single-tier — every table is canonical (tier 2), and tier 3 holds nothing yet; it is a reserved category for when a derived store earns its keep.

| Tier | Storage | Authoritative for | Examples |
|---|---|---|---|
| 2. Canonical | SQLite (canonical tables) | All content and application state Inkstone durably owns | Threads, Runs, Proposals, Canonical Entities, approvals, captured content |
| 3. Derived | SQLite (derived tables/indexes) | Nothing canonical; rebuildable from tier 2 | *(none built yet)* — future: an FTS projection, denormalized dashboards, or similar rebuildable views |

## Why

Content is authored only through Inkstone, into tier-2 SQLite. There is no external authoring path Core has to reconcile — no watcher, no snapshot-and-hash ingestion, no stale-base merge. That machinery was the largest *unbuilt* chunk of complexity the project ever contemplated, and it paid for a capability nobody had committed to; pinning SQLite as the single authoritative store removes it outright.

This keeps the Entity-lifecycle gate that is 0004's real reason to exist explicit:

> **Extraction candidate (tier 3) → Proposal (tier 2) → Accepted Entity (tier 2).**

Putting Accepted Entities in the same tier as a rebuildable index (an FTS projection, say) would mean "rebuild from sources" silently destroys user decisions. Splitting tier 2 from tier 3 keeps the contract explicit: tier 3 can be dropped and rebuilt at any time; tier 2 cannot.

## Consequences

- **Backup and recovery.** Tier 2 is what must survive a backup — the SQLite database (plus the Credential Store, which sits outside the tier model per ADR-0007). Tier 3 may be discarded and rebuilt.
- **Schema separation.** Canonical and projection tables remain mechanically distinguishable (separate schemas, naming convention, or comments).
- **Migration discipline.** Schema changes to tier 2 are migrations with the usual care; tier-3 changes can be drop-and-rebuild.
- **The Entity lifecycle is constrained, unchanged.** Extraction candidate (tier 3) → Proposal (tier 2) → Accepted Entity (tier 2). Skipping the Proposal step for agent-originated Entities would let tier 3 drive tier 2 silently.
- **Chokepoint untouched.** Worker and Clients never touch the SQLite database directly (ADR-0002, ADR-0003); only Core reads and writes it.

## What this does not decide

- The canonical content shape in SQL for non-chat content (a captures table? Messages + Entities only? something else). Open while use cases stay exploratory.

## Considered and rejected

- **A three-tier model with an authoritative on-disk-files tier + snapshot/ingestion/reconciliation (an earlier draft of this decision).** Rejected: external editing turned out not to be a required capability for the foreseeable slices, and the reconciliation machinery — watcher, stable-instant snapshots, content-hash identity, stale-base writes — was the single largest unbuilt complexity in the project. Pinning SQLite as authoritative deletes that complexity outright and replaces it with one rule the rest of the system can rely on.

## Related

- [ADR-0002](./0002-clients-talk-only-to-core.md), [ADR-0003](./0003-worker-via-tool-protocol.md) — chokepoint rules; unchanged.
- [ADR-0007](./0007-local-first-single-user.md) — Credential Store sits outside the tier model.
