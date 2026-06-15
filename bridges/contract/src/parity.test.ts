// The schema parity gate (slice 1: `create_todo` only). For each covered wire
// kind, run its hand-authored Effect Schema through `JSONSchema.make`, normalize
// it, and assert deep-equality with the normalized Rust fixture — proving the
// Core (`PayloadSpec`) and Web (Effect Schema) definitions of the wire `payload`
// agree on field presence/optionality/type/enum-domain. A field added on one
// side but forgotten on the other turns this red.
//
// Slices 2/3 widen `COVERED` as they author the remaining kinds; the registry
// (`schemas`) and the fixtures dir already hold all 13.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSONSchema, type Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";
import { schemas, type WireKind } from "./schemas.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

const readFixture = (kind: WireKind): unknown =>
	JSON.parse(readFileSync(`${fixturesDir}${kind}.json`, "utf8"));

/** The kinds whose Effect Schema this slice asserts. Slices 2/3 append. */
const COVERED: readonly WireKind[] = [
	"create_todo",
	"create_person",
	"update_person",
	"create_project",
	"update_project",
	"update_todo",
	"delete_person",
	"delete_project",
	"delete_todo",
];

describe("schema parity (Rust PayloadSpec ≡ TS Effect Schema)", () => {
	for (const kind of COVERED) {
		it(`${kind}: Effect Schema deep-equals the Rust fixture`, () => {
			const fromEffect = normalize(
				JSONSchema.make(schemas[kind] as S.Schema.Any),
			);
			const fromRust = normalize(readFixture(kind));
			expect(fromEffect).toStrictEqual(fromRust);
		});
	}
});
