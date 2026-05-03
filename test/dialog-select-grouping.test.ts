import { describe, expect, test } from "bun:test";
import type { DialogSelectOption } from "../src/tui/ui/dialog-select";
import {
	countRows,
	groupByCategory,
} from "../src/tui/ui/dialog-select-grouping";

/**
 * Pure-data tests for the grouping + row-count helpers extracted from
 * `DialogSelect`. These pin the insertion-order invariant (so callers
 * like `DialogModel` whose options are pre-ordered see byte-identical
 * layout) and the header-counting math that `height()` relies on.
 *
 * The "dormant caveat" around empty-string bucket + non-empty header
 * ordering is documented in `countRows`' docblock — it's unreachable
 * through every current caller but we pin the buggy-by-design output
 * here so a future fix surfaces as a visible behavior change with a
 * failing assertion, not a silent wobble.
 */

function opt(title: string, category?: string): DialogSelectOption<string> {
	return { title, value: title, category };
}

describe("groupByCategory", () => {
	test("preserves first-appearance order of categories", () => {
		const input = [
			opt("a1", "A"),
			opt("b1", "B"),
			opt("a2", "A"),
			opt("c1", "C"),
			opt("b2", "B"),
		];
		const grouped = groupByCategory(input);
		expect(grouped.map(([c]) => c)).toEqual(["A", "B", "C"]);
		expect(grouped[0]?.[1].map((o) => o.title)).toEqual(["a1", "a2"]);
		expect(grouped[1]?.[1].map((o) => o.title)).toEqual(["b1", "b2"]);
		expect(grouped[2]?.[1].map((o) => o.title)).toEqual(["c1"]);
	});

	test("uncategorized options land in the empty-string bucket", () => {
		const input = [opt("x"), opt("y", "A"), opt("z")];
		const grouped = groupByCategory(input);
		expect(grouped.map(([c]) => c)).toEqual(["", "A"]);
		expect(grouped[0]?.[1].map((o) => o.title)).toEqual(["x", "z"]);
		expect(grouped[1]?.[1].map((o) => o.title)).toEqual(["y"]);
	});

	test("empty input produces no buckets", () => {
		expect(groupByCategory([])).toEqual([]);
	});

	test("a single uncategorized option produces one empty-string bucket", () => {
		const grouped = groupByCategory([opt("solo")]);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]?.[0]).toBe("");
		expect(grouped[0]?.[1]).toHaveLength(1);
	});
});

describe("countRows", () => {
	test("zero groups → zero rows", () => {
		expect(countRows([])).toBe(0);
	});

	test("all uncategorized → no header lines added", () => {
		const grouped = groupByCategory([opt("a"), opt("b"), opt("c")]);
		expect(countRows(grouped)).toBe(3);
	});

	test("single non-empty group → one header + N options", () => {
		const grouped = groupByCategory([opt("a", "A"), opt("b", "A")]);
		// 2 options + 1 header = 3 rows.
		expect(countRows(grouped)).toBe(3);
	});

	test("two consecutive non-empty groups → spacer adds one line", () => {
		const grouped = groupByCategory([
			opt("a", "A"),
			opt("b", "B"),
			opt("c", "B"),
		]);
		// 3 options + 1 header (first) + 2 (second header + spacer) = 6.
		expect(countRows(grouped)).toBe(6);
	});

	test("three consecutive non-empty groups accumulate spacers", () => {
		const grouped = groupByCategory([
			opt("a", "A"),
			opt("b", "B"),
			opt("c", "C"),
		]);
		// 3 options + 1 (A header) + 2 (B header + spacer) + 2 (C header + spacer) = 8.
		expect(countRows(grouped)).toBe(8);
	});

	test("dormant caveat: empty-bucket at index 0 skips header, next bucket pays spacer", () => {
		// When uncategorized options lead, `grouped[0]` is the empty-
		// string bucket (no header rendered). `grouped[1]` is a real
		// header but at index > 0 it incurs the +2 (header + spacer)
		// path even though it's visually the first header. This pins
		// the known buggy output; fix alongside the first caller that
		// mixes categorized and uncategorized options.
		const grouped = groupByCategory([opt("x"), opt("y", "A")]);
		expect(grouped.map(([c]) => c)).toEqual(["", "A"]);
		// 2 options + 0 (empty bucket contributes nothing) + 2 (A
		// header at index 1: header line + spacer line) = 4.
		expect(countRows(grouped)).toBe(4);
	});
});
