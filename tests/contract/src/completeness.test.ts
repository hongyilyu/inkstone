// The completeness lock. The per-kind parity test (`parity.test.ts`) catches a
// CHANGED field; this catches a MISSING (or stray) KIND — the failure mode that
// per-kind assertions are blind to. It pins three sets equal, all to the
// canonical 14 wire kinds:
//   1. the Effect Schema registry keys (`Object.keys(schemas)`),
//   2. the committed Rust fixture filenames (`fixtures/*.json`, the
//      schema-of-record Core emits), and
//   3. `WIRE_KINDS` — the hand-maintained canonical list mirroring
//      `ProposableMutation::ALL` (`mutation.rs`).
//
// So a 15th proposable kind added Core-side (a new fixture appears) but not
// mirrored in TS trips the fixtures-vs-registry check; dropping a schema from
// the registry trips registry-vs-canonical; renaming a fixture trips
// fixtures-vs-canonical. Each failure names the offending kind.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemas } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";

/** The 14 agent-proposable wire kinds, verbatim from `ProposableMutation::ALL`
 * (`crates/core/src/.../mutation.rs`, via `as_wire`). The single source the two
 * derived sets (registry keys, fixture filenames) are locked against. */
const WIRE_KINDS = [
	"create_journal_entry",
	"update_journal_entry",
	"delete_journal_entry",
	"reference_existing_entity_from_journal_entry",
	"create_person",
	"update_person",
	"delete_person",
	"create_project",
	"update_project",
	"delete_project",
	"create_todo",
	"update_todo",
	"delete_todo",
	"apply_intent_graph",
] as const;

/** Canonical comparison form: a deduped, sorted array of kind names. */
const asSet = (kinds: readonly string[]): string[] => [...kinds].sort();

const fixtureKinds = (): string[] => {
	const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.replace(/\.json$/, ""));
};

describe("completeness lock — all 14 proposable kinds covered", () => {
	it("the canonical list holds exactly 14 unique kinds", () => {
		expect(WIRE_KINDS).toHaveLength(14);
		expect(new Set(WIRE_KINDS).size).toBe(14);
	});

	it("registry keys == the 14 wire kinds (no kind unmapped, none extra)", () => {
		expect(asSet(Object.keys(schemas))).toStrictEqual(asSet(WIRE_KINDS));
	});

	it("committed fixture filenames == the 14 wire kinds (no stray/missing fixture)", () => {
		expect(asSet(fixtureKinds())).toStrictEqual(asSet(WIRE_KINDS));
	});
});
