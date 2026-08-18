// The read-data parity gate (ADR-0009 as-built: read-data schema coverage).
//
// Each Entity Type's stored `data` blob crosses the wire opaquely (`S.Unknown`).
// The Web codec decodes it against a RELAXED read schema (`read*Data`). This test
// pins that read schema as a strict SUPERSET of the write schema's field-set for
// the gated pair (person / project): it must list every field the write
// `*_core` advertises (so a Rust field-add that reds the write fixture and forces
// the write schema ALSO reds here until the read schema tracks it), PLUS it must
// tolerate the sparse/empty rows the write schema rejects.
//
// The asymmetry — lenient ingest, strict emit — is therefore machine-checked, not
// reviewer-trusted (the discipline openai/codex's app-server enforces in CI for
// its Rust↔TS protocol). JournalEntry and Media have no gated write-DATA core
// (JE's payload models write-only body/target; Media is ungated per ADR-0059),
// so their read schemas are hand-authored and deliberately out of this gate.

import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	personCore,
	projectCore,
	readPersonData,
	readProjectData,
} from "../src/index.js";

/** Field names of a Struct (`.fields`) or a plain field-map, sorted. */
const keysOf = (schemaOrFields: object): string[] => {
	const fields = (schemaOrFields as { fields?: Record<string, unknown> })
		.fields;
	return Object.keys(fields ?? schemaOrFields).sort();
};

describe("read-data schema is a superset of the write-data schema (gated pair)", () => {
	const pair = [
		{ name: "person", read: readPersonData, write: personCore },
		{ name: "project", read: readProjectData, write: projectCore },
	] as const;

	for (const { name, read, write } of pair) {
		it(`read ${name} field-set ⊇ write ${name} field-set`, () => {
			const readKeys = new Set(keysOf(read));
			const missing = keysOf(write).filter((k) => !readKeys.has(k));
			expect(missing).toEqual([]);
		});
	}

	// The gate has teeth: a write field the read schema lacks MUST surface as
	// `missing`. This locks in that the comparison is a real, independent diff —
	// so a future refactor that derived the read keys from the write cores (the
	// vacuity that would silently turn the gate into a no-op) can no longer pass.
	it("flags a write field the read schema is missing (the gate is not vacuous)", () => {
		const writeWithExtra = S.Struct({
			...personCore,
			brand_new_write_field: S.String,
		});
		const readKeys = new Set(keysOf(readPersonData));
		const missing = keysOf(writeWithExtra).filter((k) => !readKeys.has(k));
		expect(missing).toEqual(["brand_new_write_field"]);
	});
});

describe("read-data schema tolerates what the write schema rejects", () => {
	it("read person accepts an empty row; write person rejects it (name required)", () => {
		expect(() => S.decodeUnknownSync(S.Struct(personCore))({})).toThrow();
		expect(S.decodeUnknownSync(readPersonData)({})).toEqual({});
	});

	it("read project accepts every field a valid write project carries", () => {
		const full = {
			name: "Lead Ads",
			status: "active",
			note: "the Q3 push",
			defer_at: "2026-06-22T09:00:00",
		};
		expect(S.decodeUnknownSync(readProjectData)(full)).toEqual(full);
	});
});
