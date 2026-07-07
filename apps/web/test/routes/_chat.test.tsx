import type { RunHistoryResult } from "@inkstone/protocol";
import type { WsClientService, WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";

// Multiple routers across tests; vitest config has no `globals`, so clean up manually.
afterEach(cleanup);

/** The `_chat` layout owns the shared shell (Sidebar + recent-Runs rail) and an
 *  `<Outlet/>` for the center — ADR-0061. These tests drive the real route tree. */
describe("_chat layout route (ADR-0061)", () => {
	it("renders the three-region shell with the recent-runs rail at /", async () => {
		await renderWithCore(
			<RouterProvider
				router={createRouter({
					routeTree,
					history: createMemoryHistory({ initialEntries: ["/"] }),
				})}
			/>,
			{ wsConfig: { url: "ws://stub/ws" } },
		);
		// RouterProvider mounts the matched route asynchronously.
		expect(
			await screen.findByRole("complementary", { name: /sidebar/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
		expect(
			screen.getByRole("complementary", { name: /recent runs/i }),
		).toBeInTheDocument();
	});

	it("navigates to a run's thread route when a feed row is clicked", async () => {
		const overrides: Partial<WsClientService> = {
			threadList: () => Effect.succeed({ threads: [] }),
			getRunHistory: (): Effect.Effect<RunHistoryResult, WsError> =>
				Effect.succeed({
					runs: [
						{
							run_id: "r1",
							thread_id: "thread-77",
							title: "Clickable run",
							kind: "done",
							at: Date.now(),
						},
					],
				}),
			threadGet: () => Effect.never,
			listEntities: () => Effect.succeed({ entities: [] }),
		};
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await renderWithCore(<RouterProvider router={router} />, { overrides });

		const row = await screen.findByRole("button", { name: /Clickable run/ });
		await userEvent.click(row);

		// Opening a Run's Thread is a navigation now (ADR-0061), not a store poke.
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/thread/thread-77");
		});
	});
});
