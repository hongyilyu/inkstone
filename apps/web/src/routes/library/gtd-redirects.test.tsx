import { WsClient } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@/test-utils/renderWithQuery";

// Multiple routers across tests; vitest config has no `globals`, so clean up manually.
afterEach(cleanup);

/** A WsClient that serves empty entity lists (the redirects don't depend on data);
 * every other method dies — they're not exercised on a redirect. */
function emptyRuntime() {
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
		listEntities: () => Effect.succeed({ entities: [] }),
		getBacklinks: () => unused,
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

/** The flat-era workflow routes redirect to GTD with the matching filter pill
 * (ADR-0054 Slice 6) — they no longer present a competing UI. */
describe("library workflow-route redirects (ADR-0054)", () => {
	const cases: { from: string; filt: string }[] = [
		{ from: "/library/inbox", filt: "inbox" },
		{ from: "/library/waiting", filt: "waiting" },
		{ from: "/library/scheduled", filt: "scheduled" },
		{ from: "/library/review", filt: "review" },
	];

	for (const { from, filt } of cases) {
		it(`redirects ${from} → /library/gtd?filt=${filt}`, async () => {
			const runtime = emptyRuntime();
			const router = createRouter({
				routeTree,
				history: createMemoryHistory({ initialEntries: [from] }),
			});
			renderWithQuery(
				<RuntimeProvider runtime={runtime}>
					<RouterProvider router={router} />
				</RuntimeProvider>,
			);

			await waitFor(() => {
				expect(router.state.location.pathname).toBe("/library/gtd");
			});
			expect((router.state.location.search as { filt?: string }).filt).toBe(
				filt,
			);

			await runtime.dispose();
		});
	}
});
