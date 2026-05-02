/**
 * Tool arg renderers — the display contract for tool calls.
 *
 * These tests pin the per-tool rendering contract that `ToolPart` in
 * `src/tui/components/message.tsx` depends on, plus the behavior for
 * unknown tools (empty string → no args row, just the tool name).
 */

import { describe, expect, test } from "bun:test";
import {
	renderToolArgs,
	TOOL_ARG_RENDERERS,
} from "../src/bridge/tool-renderers";

describe("renderToolArgs", () => {
	test("read renders the path", () => {
		expect(renderToolArgs("read", { path: "notes/foo.md" })).toBe(
			"notes/foo.md",
		);
	});

	test("read falls back to filePath when path is absent", () => {
		expect(renderToolArgs("read", { filePath: "x.md" })).toBe("x.md");
	});

	test("read truncates to 80 chars with ellipsis", () => {
		const long = `a/${"x".repeat(100)}`;
		const out = renderToolArgs("read", { path: long });
		expect(out.length).toBe(80);
		expect(out.endsWith("…")).toBe(true);
	});

	test("write renders the path like read", () => {
		expect(renderToolArgs("write", { path: "a.md" })).toBe("a.md");
	});

	test("edit renders path + edit count (singular)", () => {
		expect(
			renderToolArgs("edit", { path: "a.md", edits: [{ oldText: "x" }] }),
		).toBe("a.md (1 edit)");
	});

	test("edit renders path + edit count (plural)", () => {
		expect(
			renderToolArgs("edit", {
				path: "a.md",
				edits: [{ oldText: "x" }, { oldText: "y" }, { oldText: "z" }],
			}),
		).toBe("a.md (3 edits)");
	});

	test("edit defaults to 1 edit when edits is absent", () => {
		expect(renderToolArgs("edit", { path: "a.md" })).toBe("a.md (1 edit)");
	});

	test("write does not render an edit count (distinct from edit)", () => {
		// Regression guard: a future copy-paste bug that mirrors edit's
		// logic into write would start rendering `(1 edit)` suffixes on
		// plain writes.
		expect(renderToolArgs("write", { path: "a.md" })).toBe("a.md");
		expect(renderToolArgs("write", { path: "a.md", edits: [1, 2, 3] })).toBe(
			"a.md",
		);
	});

	test("update_sidebar renders operation + id", () => {
		expect(
			renderToolArgs("update_sidebar", {
				operation: "upsert",
				id: "watch-for",
			}),
		).toBe(`upsert "watch-for"`);
		expect(
			renderToolArgs("update_sidebar", { operation: "delete", id: "old" }),
		).toBe(`delete "old"`);
	});

	test("unknown tool returns empty string (no args row)", () => {
		expect(renderToolArgs("mystery_tool", { whatever: 1 })).toBe("");
	});

	test("null/non-object args render without throwing", () => {
		expect(renderToolArgs("read", null)).toBe("");
		expect(renderToolArgs("read", "a-string")).toBe("");
		expect(renderToolArgs("edit", undefined)).toBe(" (1 edit)");
	});

	test("TOOL_ARG_RENDERERS has the four known tools", () => {
		expect(Object.keys(TOOL_ARG_RENDERERS).sort()).toEqual([
			"edit",
			"read",
			"update_sidebar",
			"write",
		]);
	});
});
