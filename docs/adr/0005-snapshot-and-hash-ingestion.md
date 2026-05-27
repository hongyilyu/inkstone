# Snapshot-and-hash ingestion

Vault interactions are mediated through stable content identity, not raw filesystem events. Reads operate on **Snapshots** (the byte content at a stable instant, plus its content hash). Writes are conditional on the Snapshot they were authored against. The Vault is never updated based on assumptions about what was last seen.

## Why

File sync (iCloud, Dropbox, syncthing) and filesystem watchers are not clean transactional event sources. A watcher may fire while a file is mid-write, deliver duplicate events for one logical change, or re-order events when sync resolves a delta. Treating those events as authoritative produces ingestion that is sometimes wrong in ways that are hard to reproduce and hard to recover from.

Anchoring everything to content identity (a hash of the actual bytes Core read at a stable instant) makes the pipeline idempotent, replay-safe, and tolerant of watcher noise.

## The principle, applied

**On reads (Ingestion):**

1. Watcher notices a possible file change.
2. Core reads a stable Snapshot of the file.
3. Core computes the content hash.
4. Core records ingestion bookkeeping and updates Projections transactionally.
5. Tier 3 derived state (see [ADR-0004](./0004-three-tier-storage-authority.md)) can be regenerated from any accepted Snapshot.

**On writes (Reconciliation):**

1. Every Core-authored Vault write is conditional on a base Snapshot — the version of the file the write was authored against.
2. If the file's current Snapshot does not match the base, the write is a stale-base write and must be reconciled rather than blindly applied.
3. Writes must never leave the Vault in an in-between state visible to ingestion. Partial writes are not permitted; the technique used to achieve that (e.g., temp file + atomic rename) is implementation detail.

## Out of scope for this ADR

- Hash algorithm choice.
- Whether Snapshots are stored verbatim or recomputed.
- Watcher implementation (notify, fsevents, polling fallback).
- The product-level policy for resolving stale-base writes (auto-merge, prompt user, abort) — that decision is deferred until the first Workflow that does writes ships.

## Why this is generic

The pattern is not specific to Todos, People, or any one Entity type. It applies to every Vault file Inkstone reads or writes. Applying it generically prevents per-feature special cases that would inevitably skip the conflict check in the name of velocity.

## Related

- [ADR-0004](./0004-three-tier-storage-authority.md) — the storage tiers Snapshots feed into.
