import type { ThreadListResult } from "@inkstone/protocol";
import { WsClient, type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatRoute } from "@/test-utils/renderChatRoute";
import { Route } from "./archived.js";

afterEach(cleanup);

/**
 * A WsClient stub that drives ONLY `threadListArchived` (the one read the view
 * exercises); every other method dies if touched, proving the view reads nothing
 * else. The empty-list and load-failure cases below each supply a different
 * `listArchived` to pin the view's `threads.length === 0` and `isError` branches.
 */
function makeArchivedRuntime(
	listArchived: () => Effect.Effect<ThreadListResult, WsError>,
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => Effect.succeed({ threads: [] }),
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: listArchived,
		getRunHistory: () => Effect.die("not exercised"),
		recurrencePreview: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		observationQuery: () => unused,
		observationUpdate: () => unused,
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
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

// Stub WsClient whose `threadListArchived` returns 2 archived Threads and SHRINKS
// to 1 after `threadUnarchive` records its call — the mutate-then-reread pattern
// (cf. makeGrowingStubRuntime), inverted to shrink. So a restore drops the row on
// refetch, proving the archived list re-reads on success.
function makeShrinkingArchivedRuntime() {
	const unused = Effect.die("not exercised in this test");
	const threadUnarchive = vi.fn((_id: string) => {});
	let archived: { id: string; title: string; last_activity_at: number }[] = [
		{ id: "a-1", title: "Old standup", last_activity_at: 2 },
		{ id: "a-2", title: "Stale plan", last_activity_at: 1 },
	];
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => Effect.succeed({ threads: [] }),
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: (threadId: string) =>
			Effect.sync(() => {
				threadUnarchive(threadId);
				archived = archived.filter((t) => t.id !== threadId);
				return { thread_id: threadId };
			}),
		threadListArchived: () => Effect.sync(() => ({ threads: [...archived] })),
		getRunHistory: () => Effect.die("not exercised"),
		recurrencePreview: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		observationQuery: () => unused,
		observationUpdate: () => unused,
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
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
	});
	return {
		runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
		threadUnarchive,
	};
}

describe("Archived view (ADR-0052)", () => {
	it("lists archived threads and restores one", async () => {
		const user = userEvent.setup();
		const { runtime, threadUnarchive } = makeShrinkingArchivedRuntime();

		const ArchivedView = Route.options.component;
		if (!ArchivedView) throw new Error("archived route has no component");
		renderChatRoute(<ArchivedView />, { runtime });

		// Both archived titles render.
		expect(await screen.findByText("Old standup")).toBeInTheDocument();
		expect(screen.getByText("Stale plan")).toBeInTheDocument();

		// Restore the first → threadUnarchive(id) + the row leaves on refetch.
		await user.click(
			screen.getByRole("button", { name: "Restore thread Old standup" }),
		);
		await waitFor(() => expect(threadUnarchive).toHaveBeenCalledWith("a-1"));
		await waitFor(() =>
			expect(screen.queryByText("Old standup")).not.toBeInTheDocument(),
		);
		// The other archived row stays.
		expect(screen.getByText("Stale plan")).toBeInTheDocument();

		await runtime.dispose();
	});

	it("renders the empty state when there are no archived threads", async () => {
		const runtime = makeArchivedRuntime(() => Effect.succeed({ threads: [] }));

		const ArchivedView = Route.options.component;
		if (!ArchivedView) throw new Error("archived route has no component");
		renderChatRoute(<ArchivedView />, { runtime });

		// The DECOMPOSE-promised empty copy renders once the read settles empty…
		expect(await screen.findByText(/no archived threads/i)).toBeInTheDocument();
		// …and there are no rows / Restore affordances.
		expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /restore thread/i }),
		).not.toBeInTheDocument();

		await runtime.dispose();
	});

	it("renders an honest load-failure when the archived read errors", async () => {
		// `makeQueryClient` sets `retry: false`, so a failing read settles straight
		// into `isError` (no cached rows) → the load-failure branch, NOT the empty
		// state.
		const runtime = makeArchivedRuntime(() =>
			Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);

		const ArchivedView = Route.options.component;
		if (!ArchivedView) throw new Error("archived route has no component");
		renderChatRoute(<ArchivedView />, { runtime });

		expect(
			await screen.findByText(/couldn't load your archived conversations/i),
		).toBeInTheDocument();
		// A failed read must not masquerade as a genuinely empty archive.
		expect(screen.queryByText(/no archived threads/i)).not.toBeInTheDocument();

		await runtime.dispose();
	});
});
