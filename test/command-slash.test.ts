import { describe, expect, test } from "bun:test";
import {
	type CommandOption,
	canRunSlashEntry,
	findSlashEntry,
	type SlashSpec,
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

	describe("rule 3 — canExecute predicate", () => {
		// Optional-arg shape (`argHint` set, `takesArgs: false`) — the
		// only shape where rule 2 doesn't reject trailing prose, so this
		// is where rule 3 actually earns its keep. Pinned because the
		// reader-shaped bug it addresses is the original motivation.
		test("returns false → reject (optional-arg shape, prose-after-verb)", () => {
			const entry = makeEntry({
				name: "article",
				argHint: "[filename]",
				canExecute: (args) =>
					args.trim().length === 0 || args.trim() === "real.md",
			});
			expect(canRunSlashEntry(entry, "is a misleading title")).toBe(false);
		});

		test("returns true → accept", () => {
			const entry = makeEntry({
				name: "article",
				argHint: "[filename]",
				canExecute: () => true,
			});
			expect(canRunSlashEntry(entry, "real.md")).toBe(true);
		});

		test("does not bypass rule 1 (takesArgs + empty args)", () => {
			// Even a permissive predicate must not let rule 1 fire on
			// empty required args. canExecute is consulted AFTER shape.
			const entry = makeEntry({
				name: "query",
				takesArgs: true,
				canExecute: () => true,
			});
			expect(canRunSlashEntry(entry, "")).toBe(false);
		});

		test("does not bypass rule 2 (no-args command + trailing args)", () => {
			const entry = makeEntry({
				name: "clear",
				canExecute: () => true,
			});
			expect(canRunSlashEntry(entry, "my cache")).toBe(false);
		});

		test("undefined canExecute preserves today's behavior", () => {
			// Regression guard: omitting the predicate must not change
			// the existing two-rule decision for any caller.
			const entry = makeEntry({ name: "article", argHint: "[filename]" });
			expect(canRunSlashEntry(entry, "")).toBe(true);
			expect(canRunSlashEntry(entry, "anything")).toBe(true);
		});
	});
});

describe("findSlashEntry", () => {
	type Fixture = { id: string; slash?: SlashSpec };
	const make = (id: string, slash?: SlashSpec): Fixture => ({ id, slash });

	test("empty registry returns undefined", () => {
		expect(findSlashEntry([] as Fixture[], "clear")).toBeUndefined();
	});

	test("matches by canonical name when no aliases involved", () => {
		const entries = [
			make("a", { name: "clear" }),
			make("b", { name: "config" }),
		];
		expect(findSlashEntry(entries, "clear")?.id).toBe("a");
		expect(findSlashEntry(entries, "config")?.id).toBe("b");
	});

	test("matches by alias when no canonical with that name exists", () => {
		const entries = [make("clear-entry", { name: "clear", aliases: ["new"] })];
		expect(findSlashEntry(entries, "new")?.id).toBe("clear-entry");
	});

	test("canonical-name match always wins over alias match (precedence)", () => {
		const entries = [
			make("b", { name: "bar", aliases: ["foo"] }),
			make("a", { name: "foo" }),
		];
		expect(findSlashEntry(entries, "foo")?.id).toBe("a");
	});

	test("first alias match wins when two entries share an alias", () => {
		const entries = [
			make("first", { name: "x", aliases: ["shared"] }),
			make("second", { name: "y", aliases: ["shared"] }),
		];
		expect(findSlashEntry(entries, "shared")?.id).toBe("first");
	});

	test("entries without slash spec are skipped", () => {
		const entries = [
			make("palette", undefined),
			make("clear-entry", { name: "clear", aliases: ["new"] }),
		];
		expect(findSlashEntry(entries, "palette")).toBeUndefined();
		expect(findSlashEntry(entries, "new")?.id).toBe("clear-entry");
	});

	test("unknown name returns undefined", () => {
		const entries = [make("a", { name: "clear", aliases: ["new"] })];
		expect(findSlashEntry(entries, "unknown")).toBeUndefined();
	});

	test("/clear ↔ /new round-trip (named feature regression guard)", () => {
		const entries = [
			make("session.clear", { name: "clear", aliases: ["new"] }),
		];
		const viaCanonical = findSlashEntry(entries, "clear");
		const viaAlias = findSlashEntry(entries, "new");
		expect(viaCanonical?.id).toBe("session.clear");
		expect(viaAlias?.id).toBe("session.clear");
		expect(viaCanonical).toBe(viaAlias);
	});
});
