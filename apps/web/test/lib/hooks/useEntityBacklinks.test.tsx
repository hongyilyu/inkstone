import type { EntityBacklinksResult } from "@inkstone/protocol";
import { type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { makeCoreWrapper } from "@test/test-utils/renderWithCore";
import { journalEntryRow } from "@test/test-utils/rows";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assembleBacklinks,
	useEntityBacklinks,
} from "@/lib/hooks/useEntityBacklinks.js";

// `assembleBacklinks` mirrors `assembleLibraryItems`' DROP-on-throw discipline:
// parseJournalEntry is STRICT (throws on a malformed entry), so one bad
// "Mentioned in" row would otherwise reject the whole backlinks read and blank
// every inspector section. The bad row is dropped (with a console.warn so it
// isn't lost silently).

afterEach(() => {
	vi.restoreAllMocks();
});

describe("assembleBacklinks", () => {
	it("parses the mentioned-in set into view models", () => {
		const result = assembleBacklinks({
			mentioned_in: [
				journalEntryRow(
					"je_ok",
					[{ type: "text", text: "Met them." }],
					{ occurred_at: "2026-06-10T09:00:00" },
					{ created_at: 1000, updated_at: 1000 },
				),
			],
		});

		expect(result.mentionedIn.map((m) => m.id)).toEqual(["je_ok"]);
	});

	it("drops a malformed Journal Entry row and keeps the rest (with a warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = assembleBacklinks({
			mentioned_in: [
				journalEntryRow(
					"je_bad",
					[],
					{ occurred_at: "not-a-date" },
					{ created_at: 1000, updated_at: 1000 },
				),
				journalEntryRow(
					"je_good",
					[{ type: "text", text: "ok" }],
					{ occurred_at: "2026-06-10T09:00:00" },
					{ created_at: 1000, updated_at: 1000 },
				),
			],
		});

		expect(result.mentionedIn.map((m) => m.id)).toEqual(["je_good"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/journal_entry/i);
	});
});

describe("useEntityBacklinks degraded signal", () => {
	const mentionResult = (id: string): EntityBacklinksResult => ({
		mentioned_in: [
			journalEntryRow(
				id,
				[{ type: "text", text: "Met them." }],
				{ occurred_at: "2026-06-10T09:00:00" },
				{ created_at: 2000, updated_at: 2000 },
			),
		],
	});

	it("keeps the last good read when a refetch fails (transient blip ≠ degrade)", async () => {
		// Succeed first, fail every refetch after — the exact TanStack Query shape
		// where `isError` becomes true while `data` stays cached. `degraded` must
		// stay false so the inspector keeps the authoritative Core set instead of
		// blanking "Mentioned in" on a transient failure.
		let call = 0;
		const getBacklinks = (): Effect.Effect<EntityBacklinksResult, WsError> => {
			call += 1;
			return call === 1
				? Effect.succeed(mentionResult("je_cached"))
				: Effect.fail(new WsRequestError({ reason: "blip" }));
		};
		const { wrapper, queryClient } = makeCoreWrapper({
			overrides: { getBacklinks },
		});

		const { result } = renderHook(() => useEntityBacklinks("p_1", "person"), {
			wrapper,
		});

		await waitFor(() =>
			expect(result.current.mentionedIn.map((m) => m.id)).toEqual([
				"je_cached",
			]),
		);
		expect(result.current.degraded).toBe(false);

		// Force a refetch that fails; the cached read survives, so still not degraded.
		await queryClient.invalidateQueries({ queryKey: ["entity-backlinks"] });
		await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
		expect(result.current.mentionedIn.map((m) => m.id)).toEqual(["je_cached"]);
		expect(result.current.degraded).toBe(false);
	});

	it("degrades on a cold failure with no cached read", async () => {
		const { wrapper } = makeCoreWrapper({
			overrides: {
				getBacklinks: () =>
					Effect.fail(new WsRequestError({ reason: "core unreachable" })),
			},
		});

		const { result } = renderHook(() => useEntityBacklinks("p_2", "person"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.degraded).toBe(true));
		expect(result.current.mentionedIn).toEqual([]);
	});
});
