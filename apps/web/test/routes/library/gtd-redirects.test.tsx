import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";

// Multiple routers across tests; vitest config has no `globals`, so clean up manually.
afterEach(cleanup);

// No overrides: the harness serves empty entity lists by default (the redirects
// don't depend on data), and un-stubbed request verbs die — they're not
// exercised on a redirect.

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
			const router = createRouter({
				routeTree,
				history: createMemoryHistory({ initialEntries: [from] }),
			});
			await renderWithCore(<RouterProvider router={router} />);

			await waitFor(() => {
				expect(router.state.location.pathname).toBe("/library/gtd");
			});
			expect((router.state.location.search as { filt?: string }).filt).toBe(
				filt,
			);
		});
	}

	// A deep-linked/bookmarked selection (`?id=`) must survive the redirect so the
	// entity's detail rail still opens on the GTD surface (which threads `?id=`).
	it("forwards ?id= through the redirect to GTD", async () => {
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({
				initialEntries: ["/library/waiting?id=person_priya"],
			}),
		});
		await renderWithCore(<RouterProvider router={router} />);

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/library/gtd");
		});
		const search = router.state.location.search as {
			filt?: string;
			id?: string;
		};
		expect(search.filt).toBe("waiting");
		expect(search.id).toBe("person_priya");
	});
});
