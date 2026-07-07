import type { EntityListResult } from "@inkstone/protocol";
import type { WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { projectRow, todoRow } from "@test/test-utils/rows";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TopicNav } from "@/components/library/TopicNav";

type Rows = EntityListResult["entities"];

/** Mount TopicNav under a memory router so its TanStack `<Link>`s render as
 * anchors. When `failing`, `listEntities` rejects in the E channel (Core
 * unreachable) so `useLibraryItems` surfaces `isError`. */
function renderTopicNav(todos: Rows, projects: Rows = [], failing = false) {
	const rootRoute = createRootRoute({ component: TopicNav });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return renderWithCore(
		// biome-ignore lint/suspicious/noExplicitAny: the ad-hoc single-route router type doesn't match the app RegisteredRouter; only runtime rendering matters here.
		<RouterProvider router={router as any} />,
		{
			entities: { todo: todos, project: projects },
			...(failing
				? {
						overrides: {
							listEntities: () =>
								Effect.fail({
									_tag: "WsRequestError",
									reason: "connection_lost",
								} as WsError),
						},
					}
				: {}),
		},
	);
}

afterEach(cleanup);

describe("TopicNav", () => {
	it("renders the Today hub with the three live glance counts", async () => {
		// The hub computes against the real `new Date()`. To be clock-independent we
		// seed a deep-past due date and review date — both are always ≤ "today", so
		// they always count under dueToday / toReview regardless of when the test runs.
		renderTopicNav(
			[
				todoRow("t_inbox", "Unsorted errand"), // active, no project/due/refs → inbox
				todoRow("t_due", "Due (in the past)", {
					due_at: "2000-01-01T00:00:00",
				}),
			],
			[
				projectRow("p_review", "Overdue review", {
					next_review_at: "2000-01-01T00:00:00",
				}),
			],
		);

		expect(await screen.findByText("Today")).toBeInTheDocument();
		expect(await screen.findByText(/1 to do/i)).toBeInTheDocument();
		expect(screen.getByText(/1 due today/i)).toBeInTheDocument();
		expect(screen.getByText(/1 to review/i)).toBeInTheDocument();
	});

	it("renders the four Dive-into topic rows", async () => {
		renderTopicNav([]);
		expect(await screen.findByText("GTD")).toBeInTheDocument();
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

	it("suppresses the glance counts when the read fails (no fake zeros)", async () => {
		// A Core-unreachable read with no cached data: showing `0 to do` etc. would
		// read as a real empty workspace, so `countsUnknown` hides the stats entirely.
		// The topic dives still render — the nav stays navigable while counts are unknown.
		renderTopicNav([], [], true);

		expect(await screen.findByText("Today")).toBeInTheDocument();
		expect(await screen.findByText("GTD")).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();

		// The query settles into `isError` asynchronously; wait the stats out and
		// confirm none of the three glance lines is present.
		await waitFor(() => {
			expect(screen.queryByText(/to do$/i)).toBeNull();
		});
		expect(screen.queryByText(/due today$/i)).toBeNull();
		expect(screen.queryByText(/to review$/i)).toBeNull();
	});
});
