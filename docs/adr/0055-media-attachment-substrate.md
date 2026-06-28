# Media and attachment backend substrate

Inkstone will grow Journal Entries, observations, and tracker workflows that
carry images, audio, and files with provenance, metadata, and relationships to
existing records. Today media exists only as a `message_parts.type='attachment'`
JSON blob — no durable record, no binary storage, no metadata, no provenance, no
way to attach the same asset to more than the one message that birthed it.

## Decision

Add a **media substrate** as a Core-internal create/read path, mirroring the
Observation module's layering (`db/media.rs` facade + SQL in `db/queries.rs` +
parse/digest in `media.rs`). Two new tier-2 tables:

- `media` stores the metadata envelope: `mime`, `byte_size`, content `digest`,
  `storage_path` (relative to a media root), nullable `width`/`height`/
  `duration_ms`/`capture_time`/`thumbnail_path`, the same `created_by` +
  `created_via_proposal_id` XOR provenance as `observations`, and timestamps.
- `media_attachments` links one `media` row to **exactly one** target — an
  Entity, Message, Observation, or Proposal — via one nullable FK per target kind
  plus a `target_kind` discriminator, with a CHECK enforcing exactly-one-target
  that matches the discriminator (the `entity_sources` XOR pattern plus a kind
  column).

The existing `message_parts` attachment blob is left untouched; this substrate
is additive and not yet wired to any client/Core verb.

## Binary storage: bytes on disk, path in SQLite

The binary lives on disk under a media root; SQLite stores only the relative
`storage_path`, never the bytes. The root resolves via `media_root()` —
`INKSTONE_MEDIA_DIR` env override (empty treated as unset) else
`os_data_dir()/inkstone/media/` — the same override-or-data-dir shape as
`resolve_db_path`, `logging::log_dir`, and `skills::skills_dir`.

`storage_path` is a bare random-UUID filename in a flat root: no extension (the
`mime` column is the authority; deriving an extension would need a mime→ext map
that nothing in scope consumes) and no digest sharding (a single-user library
will not balloon a single directory). `insert_media` writes the file first, then
the row in a transaction, and unlinks the file if the transaction fails;
`delete_media` deletes the row (committing the `media_attachments` cascade)
first, then unlinks the file. Both orderings lean toward a recoverable
orphan-file-on-disk over a row that points at missing bytes.

## Digest: integrity, not identity

`digest` is the sha-256 hex of the content, stored as a plain **non-unique**
column for future integrity verification. The primary key stays a random UUID,
matching every other Core record. Content-addressed dedup (UNIQUE digest, reuse
the row for identical bytes) is deliberately **not** adopted: it buys trivial
disk savings on a single-user device at the cost of refcounting media across
attachment deletes, which the no-orphan-GC stance below is built to avoid.

## Deletion and orphans

Both FK directions cascade: `media_attachments.media_id` is
`ON DELETE CASCADE`, and each target FK is `ON DELETE CASCADE` so deleting a
Message/Entity/Observation/Proposal drops its attachment rows. Deleting the last
attachment does **not** delete the `media` row or its file — there is no orphan
garbage collection in this substrate. `delete_media(id)` is the only path that
removes bytes. Orphan GC (a sweep over media with zero attachments) is a separate
concern that would reintroduce the refcounting this design avoids; it is a
non-goal here.

## Scope boundary

This issue ships the Core-internal create/read path and its tests only. There is
**no** `media/*` RPC method, no protocol struct, no contract-parity slice, no
codec, no thumbnailer, and no UI. `insert_media` takes a fully-specified
`MediaInput` (the caller passes `mime`, dimensions, capture time); Core computes
only `byte_size` and `digest` and never sniffs mime or extracts dimensions —
that machinery (and a media wire surface) lands with the Media entity work
(#252) when a UI needs it.

## Consequences

- A future media wire verb / proposal kind attaches the parity gate to new
  client/Core structs; this substrate pre-pays the storage and link model.
- The polymorphic `media_attachments` table lets one asset attach to an Entity,
  Message, Observation, or Proposal and survive the death of any single owner —
  unlike the message-embedded `message_parts` blob it complements.
- Orphaned on-disk files (after a failed insert or a future bug) are invisible
  and harmless; a row pointing at missing bytes is a loud read error. The write
  orderings are chosen accordingly.

## Related

- [ADR-0004](./0004-three-tier-storage-authority.md) — tier-2 SQLite is
  authoritative for Core-owned content; the bytes are tier-2 content kept on disk
  with the path in SQLite.
- [ADR-0053](./0053-observation-records.md) — the module-layering and in-write-
  transaction target-validation pattern this substrate mirrors.
- [ADR-0030](./0030-journal-entry-anchored-capture.md) — the `created_by` /
  `created_via_proposal_id` provenance shape reused on `media`.
- #252 — the Media entity + media wire surface that will consume this substrate.
