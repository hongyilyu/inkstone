import type { EntityBacklinksResult } from "@inkstone/protocol";
import { WsClient, type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { assembleBacklinks, useEntityBacklinks } from "./useEntityBacklinks.js";

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

// A WsClient stub whose `getBacklinks` runs the supplied handler; unused methods die.
function makeRuntime(
	getBacklinks: (
		entityId: string,
	) => Effect.Effect<EntityBacklinksResult, WsError>,
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks,
		observationQuery: () => unused,
		observationUpdate: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		providerConfigure: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function wrapper(runtime: ReturnType<typeof makeRuntime>, client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
}

describe("useEntityBacklinks degraded signal", () => {
	const todoResult = (id: string): EntityBacklinksResult => ({
		mentioned_in: [],
		linked_todos: [todoRow({ title: "Buy milk" }, id)],
	});

	it("keeps the last good read when a refetch fails (transient blip ≠ degrade)", async () => {
		// Succeed first, fail every refetch after — the exact TanStack Query shape
		// where `isError` becomes true while `data` stays cached. `degraded` must
		// stay false so the inspector keeps the authoritative Core set instead of
		// flipping to the `allEntities` fallback on a transient failure.
		let call = 0;
		const runtime = makeRuntime(() => {
			call += 1;
			return call === 1
				? Effect.succeed(todoResult("t_cached"))
				: Effect.fail(new WsRequestError({ reason: "blip" }));
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useEntityBacklinks("p_1", "person"), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() =>
			expect(result.current.linkedTodos.map((t) => t.id)).toEqual(["t_cached"]),
		);
		expect(result.current.degraded).toBe(false);

		// Force a refetch that fails; the cached read survives, so still not degraded.
		await client.invalidateQueries({ queryKey: ["entity-backlinks"] });
		await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
		expect(result.current.linkedTodos.map((t) => t.id)).toEqual(["t_cached"]);
		expect(result.current.degraded).toBe(false);
	});

	it("degrades on a cold failure with no cached read", async () => {
		const runtime = makeRuntime(() =>
			Effect.fail(new WsRequestError({ reason: "core unreachable" })),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useEntityBacklinks("p_2", "person"), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.degraded).toBe(true));
		expect(result.current.linkedTodos).toEqual([]);
	});
});
