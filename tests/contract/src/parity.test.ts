// The schema parity gate (all proposable wire kinds). For each covered wire
// kind, run its hand-authored Effect Schema through `JSONSchema.make`, normalize
// it, and assert deep-equality with the normalized Rust fixture — proving the
// Core (`PayloadSpec`) and Web (Effect Schema) definitions of the wire `payload`
// agree on field presence/optionality/type/enum-domain. A field added on one
// side but forgotten on the other turns this red.
//
// `COVERED` is DERIVED from the schema registry, so a kind can never be
// registered-but-unasserted (a silent parity skip): every kind in `schemas`
// gets a parity row. `completeness.test.ts` in turn locks the registry to the
// fixtures dir and the canonical proposable-kind list.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	decodeJson,
	type JsonValue,
	schemas,
	type WireKind,
} from "@inkstone/protocol";
import { JSONSchema, Option, type Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

const readFixture = (kind: WireKind): JsonValue =>
	JSON.parse(readFileSync(`${fixturesDir}${kind}.json`, "utf8"));

/** Every kind in the registry is asserted — derived, never hand-listed, so a
 * newly-registered kind cannot slip through unasserted.
 * SAFETY: `WireKind` IS `keyof typeof schemas`; only `Object.keys` erases that. */
const COVERED = Object.keys(schemas) as WireKind[];

describe("schema parity (Rust PayloadSpec ≡ TS Effect Schema)", () => {
	for (const kind of COVERED) {
		it(`${kind}: Effect Schema deep-equals the Rust fixture`, () => {
			// `JSONSchema.make` returns Effect's own typed schema document; decode it
			// to the JSON the normalizer (and the Rust fixture) speak.
			const schema: S.Schema.Any = schemas[kind];
			// `JSONSchema.make` returns Effect's own typed schema document; decode it
			// to the JSON the normalizer (and the Rust fixture) speak.
			const fromEffect = normalize(
				Option.getOrNull(decodeJson(JSONSchema.make(schema))),
			);
			const fromRust = normalize(readFixture(kind));
			expect(fromEffect).toStrictEqual(fromRust);
		});
	}
});
