# Vault writes are one-way exports

> **Note on filename.** The slug is historical. This ADR no longer covers snapshot-and-hash ingestion (which is removed); it is kept at `0005-snapshot-and-hash-ingestion.md` to preserve inbound ADR links.

Core only ever **writes** the Vault; it never reads it back as authority. Exported documents are regenerated from tier 2 (per [ADR-0004](./0004-three-tier-storage-authority.md)). There is no watcher, no Snapshot ingestion, no Reconciliation.

## Why

Treating the Vault as an authoritative input required a stable-instant snapshot pipeline, content-hash identity, and stale-base reconciliation to tolerate sync layers and watcher noise. None of that earns its keep when the Vault is a one-way export — the bytes Core writes are the bytes Core last computed from tier 2, and the next regeneration overwrites them. There is no merge problem because there is no second writer Inkstone trusts.

## Consequences

- **The Vault is regenerated, not mutated in place.** Whether regeneration is full or incremental is implementation detail; either way, the Vault is a function of tier 2.
- **External edits are not preserved.** A user editing an exported file in Obsidian will see their edit overwritten on the next regeneration. This is the trade ADR-0004 makes: external editing is not a supported authoring path.
- **No watcher, no ingestion bookkeeping, no conflict resolution.** Removed from the system.
- **Atomic writes still matter.** Partial files visible to the user are bad UX even when nothing reads them back; the exporter writes whole files atomically (e.g., temp file + rename). Implementation detail.

## Future: drift detection (deferred to its own ADR)

A future cron may hash each exported file against a hash-on-record and, on mismatch, **notify the user to open a Thread** to fold the external edit back in. This is human-in-the-loop escalation, never auto-merge. It is not built now and is not part of this ADR; it gets its own ADR when a real need motivates it.

## Considered and rejected

- **Snapshot-and-hash ingestion with stale-base reconciliation (this ADR's prior decision).** Rejected together with the prior tier-1 authoritative Vault — see ADR-0004.

## Related

- [ADR-0004](./0004-three-tier-storage-authority.md) — the storage-authority decision this ADR is the write-side of.
- [ADR-0002](./0002-clients-talk-only-to-core.md), [ADR-0003](./0003-worker-via-tool-protocol.md) — chokepoint rules; only Core writes the Vault.
