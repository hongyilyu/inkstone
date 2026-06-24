import type { EntityBacklinksResult } from "@inkstone/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleBacklinks } from "./useEntityBacklinks.js";

// `assembleBacklinks` mirrors `assembleLibraryItems`' DROP-on-throw discipline:
// parseJournalEntry is STRICT (throws on a malformed entry), so one bad
// "Mentioned in" row would otherwise reject the whole backlinks read and blank
// every inspector section. The bad row is dropped (with a console.warn so it
// isn't lost silently); parseTodo is fail-soft and never throws.

const jeRow = (
	data: unknown,
	id: string,
): EntityBacklinksResult["mentioned_in"][number] => ({
	id,
	type: "journal_entry",
	data,
	created_at: 1000,
	updated_at: 1000,
});

const todoRow = (
	data: unknown,
	id: string,
): EntityBacklinksResult["linked_todos"][number] => ({
	id,
	type: "todo",
	data,
	created_at: 2000,
	updated_at: 2000,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("assembleBacklinks", () => {
	it("parses the two reverse sets into view models", () => {
		const result = assembleBacklinks({
			mentioned_in: [
				jeRow(
					{
						occurred_at: "2026-06-10T09:00:00",
						body: [{ type: "text", text: "Met them." }],
					},
					"je_ok",
				),
			],
			linked_todos: [todoRow({ title: "Buy milk" }, "t_ok")],
		});

		expect(result.mentionedIn.map((m) => m.id)).toEqual(["je_ok"]);
		expect(result.linkedTodos.map((t) => t.id)).toEqual(["t_ok"]);
		expect(result.linkedTodos[0]?.title).toBe("Buy milk");
	});

	it("drops a malformed Journal Entry row and keeps the rest (with a warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = assembleBacklinks({
			mentioned_in: [
				jeRow({ occurred_at: "not-a-date", body: [] }, "je_bad"),
				jeRow(
					{
						occurred_at: "2026-06-10T09:00:00",
						body: [{ type: "text", text: "ok" }],
					},
					"je_good",
				),
			],
			linked_todos: [],
		});

		expect(result.mentionedIn.map((m) => m.id)).toEqual(["je_good"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/journal_entry/i);
	});

	it("never drops a fail-soft Todo row (a sparse todo defaults, never throws)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = assembleBacklinks({
			mentioned_in: [],
			linked_todos: [todoRow({}, "t_sparse")],
		});

		expect(result.linkedTodos.map((t) => t.id)).toEqual(["t_sparse"]);
		expect(warn).not.toHaveBeenCalled();
	});
});
