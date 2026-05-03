import { describe, expect, test } from "bun:test";
import {
	type CommandOption,
	canRunSlashEntry,
} from "../src/tui/components/dialog/command";

/**
 * Pure unit tests for the exported `canRunSlashEntry` gating rule.
 *
 * The prompt's submit handler dispatches `/name args` through
 * `canRunSlash` → `canRunSlashEntry`. There are two gating rules
 * (see the function's docblock) and four combinations of (takesArgs,
 * argHint, args). Pinning the function directly lets a refactor of
 * the containing registry surface a gating regression here rather
 * than in a TUI-level char-frame test.
 */

function makeEntry(slash: CommandOption["slash"]): CommandOption {
	return {
		id: "test",
		title: "test",
		slash,
		onSelect: () => {},
	};
}

describe("canRunSlashEntry", () => {
	describe("takesArgs: true (argument required)", () => {
		const entry = makeEntry({ name: "article", takesArgs: true });

		test("rejects empty args", () => {
			expect(canRunSlashEntry(entry, "")).toBe(false);
		});

		test("rejects whitespace-only args", () => {
			expect(canRunSlashEntry(entry, "   ")).toBe(false);
		});

		test("accepts non-empty args", () => {
			expect(canRunSlashEntry(entry, "foo.md")).toBe(true);
		});
	});

	describe("takesArgs: false, no argHint (no-args command)", () => {
		const entry = makeEntry({ name: "clear" });

		test("accepts empty args (bare invocation)", () => {
			expect(canRunSlashEntry(entry, "")).toBe(true);
		});

		test("rejects trailing args (extra-args guard so /clear foo falls through as a plain prompt)", () => {
			expect(canRunSlashEntry(entry, "my cache")).toBe(false);
		});
	});

	describe("takesArgs: false + argHint (optional-arg command)", () => {
		const entry = makeEntry({
			name: "article",
			argHint: "[filename]",
		});

		test("accepts empty args (bare invocation opens picker)", () => {
			expect(canRunSlashEntry(entry, "")).toBe(true);
		});

		test("accepts trailing args (optional arg typed)", () => {
			expect(canRunSlashEntry(entry, "foo.md")).toBe(true);
		});

		test("accepts whitespace-only args (treated as bare)", () => {
			expect(canRunSlashEntry(entry, "   ")).toBe(true);
		});
	});

	describe("no slash spec at all", () => {
		// Defensive: the function should not crash on an entry with no
		// `slash` field. Registry code guards this before calling, but
		// the unit is easier to reason about if it stays total.
		const entry: CommandOption = {
			id: "palette-only",
			title: "palette only",
			onSelect: () => {},
		};

		test("no slash spec + empty args → true (no rule rejects)", () => {
			expect(canRunSlashEntry(entry, "")).toBe(true);
		});

		test("no slash spec + non-empty args → false (rule 2 still fires)", () => {
			// `!spec?.takesArgs` is true (undefined), `!spec?.argHint` is
			// true (undefined), args non-empty → rule 2 rejects.
			expect(canRunSlashEntry(entry, "stuff")).toBe(false);
		});
	});
});
