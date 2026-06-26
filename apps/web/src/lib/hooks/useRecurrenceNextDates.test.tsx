import type { RecurrencePreviewResult } from "@inkstone/protocol";
import { WsClient, WsRequestError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoDraft } from "@/lib/entityCodec";
import { todoDraftFromVm } from "@/lib/entityCodec";
import { RuntimeProvider } from "@/runtime";
import { useRecurrenceNextDates } from "./useRecurrenceNextDates.js";

afterEach(() => {
	vi.restoreAllMocks();
});

// A WsClient stub whose `recurrencePreview` runs the supplied handler; the rest die.
function makeRuntime(recurrencePreview: WsClient["Type"]["recurrencePreview"]) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		recurrencePreview,
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => unused,
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

// A complete, bounded recurring draft → the hook's query is enabled.
const boundedDraft = (): TodoDraft => ({
	...todoDraftFromVm(undefined),
	deferDay: "2026-07-01",
	recurs: true,
	recurAnchor: "defer_at",
	recurEnd: "after",
	recurAfterCount: "5",
});

describe("useRecurrenceNextDates", () => {
	it("returns the previewed dates for a complete bounded series", async () => {
		const runtime = makeRuntime(() =>
			Effect.succeed({
				ended: false,
				defer_at: "2026-07-08T00:00:00",
			} satisfies RecurrencePreviewResult),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(
			() => useRecurrenceNextDates(boundedDraft()),
			{
				wrapper: wrapper(runtime, client),
			},
		);

		await waitFor(() =>
			expect(result.current).toEqual({
				ended: false,
				deferAt: "2026-07-08T00:00:00",
				dueAt: undefined,
			}),
		);
	});

	it("returns null without firing a read when the draft is not previewable", async () => {
		let calls = 0;
		const runtime = makeRuntime(() => {
			calls += 1;
			return Effect.succeed({ ended: false } satisfies RecurrencePreviewResult);
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		// End = never → buildRecurrencePreviewParams returns null → query disabled.
		const { result } = renderHook(
			() => useRecurrenceNextDates({ ...boundedDraft(), recurEnd: "never" }),
			{ wrapper: wrapper(runtime, client) },
		);

		await Promise.resolve();
		expect(result.current).toBeNull();
		expect(calls).toBe(0);
	});

	// The CodeRabbit fix: react-query keeps the last successful `data` after a
	// refetch fails, so a naive `query.data ?? null` would render STALE dates. The
	// hook guards on `query.isError` → null. This drives the success-then-refetch-
	// failure path (the only shape where `data` is retained alongside an error).
	it("hides stale dates when a refetch fails after a successful read", async () => {
		let call = 0;
		const runtime = makeRuntime(() => {
			call += 1;
			return call === 1
				? Effect.succeed({
						ended: false,
						defer_at: "2026-07-08T00:00:00",
					} satisfies RecurrencePreviewResult)
				: Effect.fail(new WsRequestError({ reason: "preview blip" }));
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(
			() => useRecurrenceNextDates(boundedDraft()),
			{
				wrapper: wrapper(runtime, client),
			},
		);

		// First read succeeds → dates shown.
		await waitFor(() =>
			expect(result.current?.deferAt).toBe("2026-07-08T00:00:00"),
		);

		// Same key refetch fails → react-query retains the cached data, but the
		// hook must return null rather than surface the now-stale preview.
		await client.invalidateQueries({ queryKey: ["recurrence-next"] });
		await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
		await waitFor(() => expect(result.current).toBeNull());
	});
});
