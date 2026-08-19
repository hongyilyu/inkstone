import type { EntityListResult } from "@inkstone/protocol";
import { WsRequestError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { projectRow } from "@test/test-utils/rows";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TopicNav } from "@/components/library/TopicNav";

type Rows = EntityListResult["entities"];

/** Mount TopicNav under a memory router so its TanStack `<Link>`s render as
 * anchors. When `failing`, `listEntities` rejects in the E channel (Core
 * unreachable) so `useLibraryItems` surfaces `isError`. */
function renderTopicNav(projects: Rows = [], failing = false) {
	const rootRoute = createRootRoute({ component: TopicNav });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const seeds = { entities: { project: projects } };
	return renderWithCore(
		// biome-ignore lint/suspicious/noExplicitAny: SAFETY: the ad-hoc single-route router type doesn't match the app RegisteredRouter; only runtime rendering matters here.
		<RouterProvider router={router as any} />,
		failing
			? {
					...seeds,
					overrides: {
						listEntities: () =>
							Effect.fail(new WsRequestError({ reason: "connection_lost" })),
					},
				}
			: seeds,
	);
}

afterEach(cleanup);

describe("TopicNav", () => {
	it("renders the Today hub with the live review glance count", async () => {
		// The hub computes against the real `new Date()`. To be clock-independent we
		// seed a deep-past review date — always ≤ "today", so it always counts under
		// toReview regardless of when the test runs.
		renderTopicNav([
			projectRow("p_review", "Overdue review", {
				next_review_at: "2000-01-01T00:00:00",
			}),
		]);

		expect(await screen.findByText("Today")).toBeInTheDocument();
		expect(await screen.findByText(/1 to review/i)).toBeInTheDocument();
	});

	it("renders the four Dive-into topic rows", async () => {
		renderTopicNav([]);
		expect(await screen.findByText("Tasks")).toBeInTheDocument();
		expect(screen.getByText("Timeline")).toBeInTheDocument();
		expect(screen.getByText("Health")).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();
	});

	it("drops the old flat entity-type rows", async () => {
		renderTopicNav([]);
		await screen.findByText("Today");
		expect(screen.queryByText(/bookmarks/i)).toBeNull();
		expect(screen.queryByText(/^People$/)).toBeNull();
		expect(screen.queryByText(/^Projects$/)).toBeNull();
		expect(screen.queryByText(/^Inbox$/)).toBeNull();
		expect(screen.queryByText(/^Waiting$/)).toBeNull();
	});

	it("suppresses the glance count when the read fails (no fake zeros)", async () => {
		// A Core-unreachable read with no cached data: showing `0 to review` would
		// read as a real empty workspace, so `countsUnknown` hides the stat entirely.
		// The topic dives still render — the nav stays navigable while counts are unknown.
		renderTopicNav([], true);

		expect(await screen.findByText("Today")).toBeInTheDocument();
		expect(await screen.findByText("Tasks")).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();

		// The query settles into `isError` asynchronously; wait the stat out and
		// confirm the glance line is not present.
		await waitFor(() => {
			expect(screen.queryByText(/to review$/i)).toBeNull();
		});
	});
});
