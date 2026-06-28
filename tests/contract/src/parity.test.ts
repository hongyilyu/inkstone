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
import { schemas, type WireKind } from "@inkstone/protocol";
import { JSONSchema, type Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

const readFixture = (kind: WireKind): unknown =>
	JSON.parse(readFileSync(`${fixturesDir}${kind}.json`, "utf8"));

/** Every kind in the registry is asserted — derived, never hand-listed, so a
 * newly-registered kind cannot slip through unasserted. */
const COVERED = Object.keys(schemas) as WireKind[];

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
