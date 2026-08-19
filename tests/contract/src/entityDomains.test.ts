import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTITY_MUTATION_KINDS, ENTITY_TYPE_NAMES } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";

interface EntityWireDomains {
	readonly entity_type_names: readonly string[];
	readonly entity_mutation_kinds: readonly string[];
}

// the fixture is Core's committed domains dump; the assertions below read
// exactly the two arrays this type names, and a missing one fails them.
const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../fixtures/domains/entity.json", import.meta.url)),
		"utf8",
	),
) as EntityWireDomains;

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("entity wire domains", () => {
	it("matches the shared Entity Type domain", () => {
		expect(sorted(ENTITY_TYPE_NAMES)).toStrictEqual(
			sorted(fixture.entity_type_names),
		);
	});

	it("matches the shared direct-mutation domain", () => {
		expect(sorted(ENTITY_MUTATION_KINDS)).toStrictEqual(
			sorted(fixture.entity_mutation_kinds),
		);
	});
});
