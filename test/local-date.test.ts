import { describe, expect, test } from "bun:test";
import { todayLocalDate } from "../src/backend/agent/util/local-date";

describe("todayLocalDate", () => {
	test("returns a YYYY-MM-DD string for today's local date", () => {
		const out = todayLocalDate();

		// Shape: 10 chars, two `-` at fixed positions, all-digit segments.
		// Pinning the shape (not a specific date) keeps the test stable
		// across days; the production callers (env block, reader read-
		// status comparison, KB session titles) all rely on this exact
		// shape sorting lexically and matching frontmatter conventions.
		expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		// Cross-check against a freshly-constructed Date so a contributor
		// who flips the helper to UTC, locale-formatted, or any non-local
		// shape sees this fail. We don't assert equality with the helper
		// itself (tautology); we re-derive from `new Date()` directly.
		const d = new Date();
		const expected =
			`${d.getFullYear()}-` +
			`${String(d.getMonth() + 1).padStart(2, "0")}-` +
			`${String(d.getDate()).padStart(2, "0")}`;
		expect(out).toBe(expected);
	});

});
