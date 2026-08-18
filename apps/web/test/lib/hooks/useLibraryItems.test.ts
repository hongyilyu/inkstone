import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEntityRow } from "@/lib/entityCodec";
import {
	assembleLibraryItems,
	type LibraryRows,
} from "@/lib/hooks/useLibraryItems.js";

// The footgun this guards (slice-3): parseJournalEntry is STRICT — it throws on a
// malformed entry (bad occurred_at, empty body). The Library read maps all five
// row kinds, so before this fix one bad JE row rejected the whole `entity/list`
// read and blanked the ENTIRE Library (people, projects, media
// included). assembleLibraryItems drops the offending row (with a browser
// console.warn so it isn't lost silently) so the rest renders.

const empty: LibraryRows = {
	journalEntries: [],
	people: [],
	projects: [],
	media: [],
};

const jeRow = (data: unknown, id = "je"): LiveEntityRow => ({
	id,
	data,
	created_at: 1000,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("assembleLibraryItems — one malformed JE row no longer blanks the Library", () => {
	it("drops the bad journal-entry row and keeps every other item", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const items = assembleLibraryItems({
			...empty,
			journalEntries: [
				jeRow({ occurred_at: "not-a-date", body: [] }, "bad"), // strict parse throws
				jeRow(
					{
						occurred_at: "2026-06-10T09:00:00",
						body: [{ type: "text", text: "ok" }],
					},
					"good",
				),
			],
			people: [{ id: "p1", data: { name: "Morris" }, created_at: 3000 }],
		});

		// The good JE and the person survive; only the bad JE drops.
		expect(items.map((i) => i.id).sort()).toEqual(["good", "p1"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/journal_entry/i);
	});

	it("returns every item when all rows are valid (no warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const items = assembleLibraryItems({
			...empty,
			people: [{ id: "p1", data: { name: "A" }, created_at: 1 }],
			media: [
				{
					id: "b1",
					data: { title: "B", medium: "link", state: "backlog" },
					created_at: 2,
				},
			],
		});
		expect(items.map((i) => i.id).sort()).toEqual(["b1", "p1"]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("preserves the fail-soft kinds (a sparse person row never throws, never drops)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const items = assembleLibraryItems({
			...empty,
			people: [{ id: "p_sparse", data: {}, created_at: 1 }],
		});
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("p_sparse");
		expect(warn).not.toHaveBeenCalled();
	});
});
