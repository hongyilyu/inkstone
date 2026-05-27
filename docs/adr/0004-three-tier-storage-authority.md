# Three-tier storage authority

Inkstone has three persistence tiers. Authority is scoped by *what kind of fact is being stored*, not by storage location — Vault Files and SQLite Canonical State are both authoritative, for different claims.

| Tier | Storage | Authoritative for | Examples |
|---|---|---|---|
| 1. Source content | Vault Files | User-owned and imported source content | Notes, raw captures, articles, rendered markdown intended for the user to edit |
| 2. Canonical application state | SQLite (canonical tables) | Inkstone-managed durable state | Threads, Runs, Proposals, Accepted Entities, ingestion and reconciliation bookkeeping, approvals |
| 3. Projections | SQLite (derived tables/indexes) | Nothing canonical; rebuildable from tiers 1 and/or 2 | FTS, extraction candidates, backlinks, entity-note links, dashboards, denormalized views |

## Why

The naive model — "files are content, DB is everything else" — is wrong, and the wrongness shows up at the Entity lifecycle. An Entity may originate from agent extraction, user creation, or Reconciliation. The act of *accepting* an Entity is not a re-derivation of source content; it is an authoritative decision Inkstone makes and must remember. Putting Accepted Entities in the same tier as FTS indexes would mean "rebuild from sources" silently destroys user decisions.

Splitting tier 2 from tier 3 makes the contract explicit: tier 3 can be dropped and rebuilt at any time; tier 2 cannot.

The Vault and SQLite both being authoritative is not a contradiction because they answer different questions:

- **Vault is authoritative for**: "what did I actually write in this note?"
- **SQLite tier 2 is authoritative for**: "which canonical Person record does 'Alice' resolve to?", "which Runs have I executed?", "what Proposals are pending?"
- **SQLite tier 3 is authoritative for nothing**: "which notes currently mention Alice?" is re-derivable.

## Consequences

- **Backup and recovery**: tier 1 + tier 2 are what must survive a backup. Tier 3 may be discarded and rebuilt. A backup strategy that captures only the Vault is insufficient; one that captures the Vault and the canonical SQLite tables is sufficient.
- **Schema separation**: canonical and projection tables should be distinguishable (separate schemas, naming convention, or comments) so it is mechanically clear which tier any table belongs to.
- **Migration discipline**: schema changes to tier 2 are migrations with the usual care; schema changes to tier 3 can be implemented as drop-and-rebuild.
- **The Entity lifecycle is constrained**: extraction candidate (tier 3) → Proposal (tier 2) → Accepted Entity (tier 2). Skipping the Proposal step for agent-originated Entities would let tier 3 drive tier 2 silently.

## Related

- [ADR-0005](./0005-snapshot-and-hash-ingestion.md) — how tier 1 changes propagate into tier 2 and tier 3.
