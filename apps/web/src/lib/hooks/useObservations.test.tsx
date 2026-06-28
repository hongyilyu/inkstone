import type { ObservationRow } from "@inkstone/protocol";
import { WsClient, WsRequestError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import {
	assembleObservationItems,
	useObservations,
} from "./useObservations.js";

const row = (
	over: Partial<ObservationRow> & Pick<ObservationRow, "schema_key" | "values">,
): ObservationRow => ({
	id: "obs-1",
	schema_version: 1,
	occurred_at: "2026-06-10T09:00:00",
	ended_at: null,
	note: null,
	source: null,
	created_at: 1000,
	updated_at: 1000,
	...over,
});

describe("assembleObservationItems", () => {
	it("maps each row through toObservationView", () => {
		const items = assembleObservationItems([
			row({ id: "bw", schema_key: "bodyweight", values: { kg: 72.4 } }),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("bw");
		expect(items[0]?.summary).toContain("72.4 kg");
	});

	it("an empty observation list yields []", () => {
		expect(assembleObservationItems([])).toEqual([]);
	});
});

// A WsClient stub whose `observationQuery` runs the supplied handler; the rest die.
function makeRuntime(observationQuery: WsClient["Type"]["observationQuery"]) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		recurrencePreview: () => unused,
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		observationQuery,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
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

describe("useObservations", () => {
	it("maps queried rows through the view layer", async () => {
		const runtime = makeRuntime(() =>
			Effect.succeed({
				observations: [
					row({ id: "bw", schema_key: "bodyweight", values: { kg: 72.4 } }),
				],
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useObservations(), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.data).toHaveLength(1));
		expect(result.current.data?.[0]?.summary).toContain("72.4 kg");
	});

	it("surfaces a Core-unreachable read as isError, NOT an empty list", async () => {
		// The load-bearing guarantee (mirrors useLibraryItems): a failed read must
		// reject so the view shows the distinct "Couldn't load" state, never []. A
		// regression that swallowed the rejection to [] would otherwise pass silently.
		const runtime = makeRuntime(() =>
			Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useObservations(), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
	});
});
