// The non-payload wire-message parity gate (grilling Q1–Q4). For each committed
// fixture, the hand-authored Effect Schema must:
//   1. DECODE the fixture with `onExcessProperty: "error"` — a field present in
//      the (Rust-emitted or canonical) fixture but absent from the TS schema reds
//      here. This catches the Rust-has / TS-lacks drift direction.
//   2. Re-ENCODE the decoded value and deep-equal the original fixture — a field
//      the TS schema drops, renames, or coerces reds here. This catches the
//      TS-side mutation direction. (Effect's `encodeSync` OMITS an absent
//      optional rather than emitting `null`, so this round-trips cleanly for the
//      `skip_serializing_if` fields the wire omits.)
//
// This is the INSTANCE-based gate: the fixture is a real serialized value (Core's
// ground-truth serde output, or the canonical wire JSON Web sends), NOT a
// schema. `normalize.ts` is the payload gate's schema-vs-schema reconciler and
// plays no part here.
//
// Accepted blind spot (Q3): a field optional on the TS side and entirely absent
// on the Rust side is invisible — Rust never emits it, so no fixture exercises it
// and decode-without-it succeeds. Low severity (a permissive phantom field Web
// accepts but Core never sends — dead schema, not a crash). This is the price of
// instance-based vs the schema-vs-schema payload gate.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { fixtures } from "./structs.registry.js";

const fixturesRoot = fileURLToPath(
	new URL("../fixtures/structs/", import.meta.url),
);

const readFixture = (dir: string, file: string): unknown =>
	JSON.parse(readFileSync(`${fixturesRoot}${dir}/${file}`, "utf8"));

describe("non-payload wire-message parity (Rust serde ≡ TS Effect Schema)", () => {
	for (const { message, file, schema, dir } of fixtures) {
		it(`${file}: ${message} decodes (no excess) + re-encodes to the same fixture`, () => {
			const fixture = readFixture(dir, file);
			// Decode rejects an excess property — a field the fixture carries but
			// the schema doesn't know about (Rust-has / TS-lacks).
			const decoded = S.decodeUnknownSync(schema, {
				onExcessProperty: "error",
			})(fixture);
			// Re-encode must reproduce the fixture exactly (TS dropping / renaming /
			// coercing a present field reds here). Key order is irrelevant to
			// `toEqual`/`toStrictEqual` for plain objects.
			const reEncoded = S.encodeUnknownSync(schema)(decoded);
			expect(reEncoded).toStrictEqual(fixture);
		});
	}
});
