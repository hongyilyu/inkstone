# Storage authority: SQLite is the single source of truth

> **Note on filename.** The slug is historical. Inkstone now has **two** tiers, not three; the file is kept at `0004-three-tier-storage-authority.md` to preserve inbound ADR links.

Inkstone has two persistence tiers. SQLite is authoritative for everything Core durably owns — content **and** application state. The Vault is no longer an authoritative tier; it is a tier-3 derived export.

| Tier | Storage | Authoritative for | Examples |
|---|---|---|---|
| 2. Canonical | SQLite (canonical tables) | All content and application state Inkstone durably owns | Threads, Runs, Proposals, Accepted Entities, approvals, captured content |
| 3. Derived | SQLite (derived tables/indexes) **+ Vault export** | Nothing canonical; rebuildable from tier 2 | FTS, backlinks, dashboards, denormalized views, exported documents in the Vault |

## Why

Earlier drafts modeled Vault Files as a separate authoritative tier so the user could edit content directly in their editor and have Inkstone reconcile. That premise required a watcher, snapshot-and-hash ingestion, and stale-base reconciliation — the largest *unbuilt* chunk of complexity in the project, paying for a capability nobody had committed to.

Collapsing to a single canonical tier (SQLite) removes that machinery and replaces it with one clear rule: content is authored only through Inkstone. The Vault becomes a one-way derived export — convenient for human reading, never re-ingested.

This does not weaken the Entity-lifecycle gate that was 0004's real reason to exist. It still holds:

> **Extraction candidate (tier 3) → Proposal (tier 2) → Accepted Entity (tier 2).**

Putting Accepted Entities in the same tier as FTS indexes would still mean "rebuild from sources" silently destroys user decisions. Splitting tier 2 from tier 3 keeps the contract explicit: tier 3 can be dropped and rebuilt at any time; tier 2 cannot.

## Consequences

- **Backup and recovery.** Tier 2 is what must survive a backup — the SQLite database (plus the Credential Store, which sits outside the tier model per ADR-0007). Tier 3 may be discarded and rebuilt; the Vault export is not a backup.
- **Schema separation.** Canonical and projection tables remain mechanically distinguishable (separate schemas, naming convention, or comments). Tier-3 includes both in-DB derived tables and the on-disk Vault export.
- **Migration discipline.** Schema changes to tier 2 are migrations with the usual care; tier-3 changes (in-DB and the Vault export format) can be drop-and-rebuild.
- **The Entity lifecycle is constrained, unchanged.** Extraction candidate (tier 3) → Proposal (tier 2) → Accepted Entity (tier 2). Skipping the Proposal step for agent-originated Entities would let tier 3 drive tier 2 silently.
- **Chokepoint untouched.** Worker and Clients still never touch the Vault directly (ADR-0002, ADR-0003). The Vault becoming derived doesn't open it up; if anything it narrows the surface, since only Core's exporter writes there.

## What this does not decide

- The canonical content shape in SQL for non-chat content (a captures table? Messages + Entities only? something else). Open while use cases stay exploratory.
- The export shape (single file vs a derived tree of documents). Open.

## Considered and rejected

- **The previous three-tier model with authoritative Vault Files + snapshot/ingestion/reconciliation (this ADR's prior decision, plus the prior ADR-0005).** Rejected: external editing turned out not to be a required capability for the foreseeable slices, and the reconciliation machinery — watcher, stable-instant snapshots, content-hash identity, stale-base writes — was the single largest unbuilt complexity in the project. Pinning SQLite as authoritative deletes that complexity outright and replaces it with one rule the rest of the system can rely on.

## Related

- [ADR-0005](./0005-snapshot-and-hash-ingestion.md) — the symmetric write-side decision: Vault writes are one-way exports.
- [ADR-0002](./0002-clients-talk-only-to-core.md), [ADR-0003](./0003-worker-via-tool-protocol.md) — chokepoint rules; unchanged.
- [ADR-0007](./0007-local-first-single-user.md) — Credential Store sits outside the tier model.
