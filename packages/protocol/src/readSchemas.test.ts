// The read-data parity gate (ADR-0009 as-built: read-data schema coverage).
//
// Each Entity Type's stored `data` blob crosses the wire opaquely (`S.Unknown`).
// The Web codec decodes it against a RELAXED read schema (`read*Data`). This test
// pins that read schema as a strict SUPERSET of the write schema's field-set for
// the gated trio (todo / person / project): it must list every field the write
// `*_core` advertises (so a Rust field-add that reds the write fixture and forces
// the write schema ALSO reds here until the read schema tracks it), PLUS it must
// tolerate the sparse/empty rows the write schema rejects.
//
// The asymmetry — lenient ingest, strict emit — is therefore machine-checked, not
// reviewer-trusted (the discipline openai/codex's app-server enforces in CI for
// its Rust↔TS protocol). JournalEntry and Bookmark have no gated write-DATA core
// (JE's payload models write-only body/target; Bookmark is ungated per ADR-0036),
// so their read schemas are hand-authored and deliberately out of this gate.

import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	personCore,
	projectCore,
	readPersonData,
	readProjectData,
	readTodoData,
	todoDataFull,
} from "./index.js";

/** Field names of a Struct (`.fields`) or a plain field-map, sorted. */
const keysOf = (schemaOrFields: object): string[] => {
	const fields = (schemaOrFields as { fields?: Record<string, unknown> })
		.fields;
	return Object.keys(fields ?? schemaOrFields).sort();
};

describe("read-data schema is a superset of the write-data schema (gated trio)", () => {
	const trio = [
		{ name: "todo", read: readTodoData, write: todoDataFull },
		{ name: "person", read: readPersonData, write: personCore },
		{ name: "project", read: readProjectData, write: projectCore },
	] as const;

	for (const { name, read, write } of trio) {
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
			...todoDataFull.fields,
			brand_new_write_field: S.String,
		});
		const readKeys = new Set(keysOf(readTodoData));
		const missing = keysOf(writeWithExtra).filter((k) => !readKeys.has(k));
		expect(missing).toEqual(["brand_new_write_field"]);
	});
});

describe("read-data schema tolerates what the write schema rejects", () => {
	it("read todo accepts an empty row; write todo rejects it (title required)", () => {
		expect(() => S.decodeUnknownSync(todoDataFull)({})).toThrow();
		expect(S.decodeUnknownSync(readTodoData)({})).toEqual({});
	});

	it("read person accepts an empty row; write person rejects it (name required)", () => {
		expect(() => S.decodeUnknownSync(S.Struct(personCore))({})).toThrow();
		expect(S.decodeUnknownSync(readPersonData)({})).toEqual({});
	});

	it("read todo accepts every field a valid write todo carries", () => {
		const full = {
			title: "buy milk",
			status: "active",
			note: "from the corner store",
			defer_at: "2026-06-22T09:00:00",
		};
		expect(S.decodeUnknownSync(readTodoData)(full)).toEqual(full);
	});
});
