// The promoted payload-schema registry (ADR-0009): the 13 agent-proposable wire
// kinds moved here from `tests/contract`, plus the 3 ungated bookmark schemas
// the Web codec consumes. This test pins the promotion (the registry is intact
// and decodes) and guards the ungated boundary (bookmark is NOT in `schemas`,
// so it stays out of the 13-kind parity lock). The parity/completeness gates in
// `tests/contract` — now sourcing the registry from here — remain the proof the
// move is byte-for-byte behavior-preserving.

import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	createBookmark,
	deleteBookmark,
	schemas,
	updateBookmark,
	type WireKind,
} from "./index.js";

/** The 13 agent-proposable wire kinds (mirrors `completeness.test`'s lock). */
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
] as const;

const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();

describe("promoted payload registry", () => {
	it("holds exactly the 13 wire kinds", () => {
		expect(sorted(Object.keys(schemas))).toStrictEqual(sorted(WIRE_KINDS));
	});

	it("decodes a valid create_todo payload", () => {
		const payload = {
			todo: { title: "buy milk", status: "active" },
		};
		expect(
			S.decodeUnknownSync(schemas.create_todo as S.Schema<unknown, unknown>)(
				payload,
			),
		).toEqual(payload);
	});
});

describe("ungated bookmark schemas (NOT in the 13-kind registry)", () => {
	it("decodes a valid create_bookmark payload", () => {
		const payload = { title: "Effect docs", url: "https://effect.website" };
		expect(S.decodeUnknownSync(createBookmark)(payload)).toEqual(payload);
	});

	it("exports updateBookmark and deleteBookmark", () => {
		expect(
			S.decodeUnknownSync(updateBookmark)({ entity_id: "b1", title: "renamed" }),
		).toEqual({ entity_id: "b1", title: "renamed" });
		expect(S.decodeUnknownSync(deleteBookmark)({ entity_id: "b1" })).toEqual({
			entity_id: "b1",
		});
	});

	it("keeps the bookmark kinds OUT of `schemas` (the ungated boundary)", () => {
		const keys = Object.keys(schemas) as WireKind[];
		expect(keys).not.toContain("create_bookmark");
		expect(keys).not.toContain("update_bookmark");
		expect(keys).not.toContain("delete_bookmark");
	});
});
