import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { TodayOverview } from "./TodayOverview";

type Rows = EntityListResult["entities"];

/** Stub WsClient serving the given entity rows by type; unused methods die. */
function makeRuntime(todos: Rows, projects: Rows = []) {
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
		listEntities: (type) => {
			if (type === "todo") return Effect.succeed({ entities: todos });
			if (type === "project") return Effect.succeed({ entities: projects });
			return Effect.succeed({ entities: [] });
		},
		getBacklinks: () => unused,
		observationQuery: () => unused,
		observationUpdate: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => Stream.empty,
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
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

/** Mount TodayOverview under a memory router so its TanStack `<Link>`s render as
 * anchors whose `href` carries the resolved route + search. */
function renderToday(todos: Rows, projects: Rows = []) {
	const runtime = makeRuntime(todos, projects);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	const rootRoute = createRootRoute({ component: TodayOverview });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	// biome-ignore lint/suspicious/noExplicitAny: the ad-hoc single-route router type doesn't match the app RegisteredRouter; only runtime rendering matters here.
	return render(<RouterProvider router={router as any} />, {
		wrapper: Wrapper,
	});
}

const todo = (
	id: string,
	title: string,
	data: Record<string, unknown> = {},
): Rows[number] => ({
	id,
	type: "todo",
	data: { title, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

const project = (
	id: string,
	name: string,
	data: Record<string, unknown> = {},
): Rows[number] => ({
	id,
	type: "project",
	data: { name, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

// Deep past = unambiguously due/reviewable regardless of the real "now".
const PAST = "2000-01-01T00:00:00";

afterEach(cleanup);

describe("TodayOverview", () => {
	it("keeps the GTD action core (due-soon todos still render)", async () => {
		// A single due-soon todo also lands in "Recently captured", so it renders in
		// more than one section — assert it appears at all (the core still renders).
		renderToday([todo("t_due", "Pay rent", { due_at: PAST })]);
		expect((await screen.findAllByText("Pay rent")).length).toBeGreaterThan(0);
	});

	it("shows a Review-now deep-link into the GTD review filter when a project is due", async () => {
		renderToday(
			[todo("t_due", "Pay rent", { due_at: PAST })],
			[project("p_review", "Quarterly planning", { next_review_at: PAST })],
		);
		// Scope to the banner's exact CTA so a stray /review/i match (e.g. future
		// copy) can't satisfy this — the link is named "Review now".
		const link = await screen.findByRole("link", { name: /review now/i });
		const href = link.getAttribute("href") ?? "";
		expect(href).toContain("/library/gtd");
		expect(href).toContain("review");
	});

	it("hides the review banner when no project is due for review", async () => {
		// A populated landing with NO reviewable project (the project carries no
		// next_review_at). Pins the `reviewable.length > 0` gate against an
		// accidental inversion/removal: no banner, no Review-now affordance.
		renderToday(
			[todo("t_due", "Pay rent", { due_at: PAST })],
			[project("p_plain", "Quarterly planning")],
		);
		expect(await screen.findByText("Today")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /review now/i })).toBeNull();
		expect(screen.queryByText(/ready for review/i)).toBeNull();
	});

	it("renders the cross-topic digest strip linking into Health and Media", async () => {
		// One item lands the populated Today landing (not the empty-state takeover),
		// where the cross-topic digest strip belongs.
		renderToday([todo("t_due", "Pay rent", { due_at: PAST })]);
		const health = await screen.findByRole("link", { name: /health/i });
		expect(health.getAttribute("href")).toContain("/library/health");
		const media = screen.getByRole("link", { name: /media/i });
		expect(media.getAttribute("href")).toContain("/library/media");
	});

	it("keeps the digest strip when the GTD sections are populated", async () => {
		// The digest renders unconditionally, not just on the near-empty landing —
		// a fully populated workspace must still surface the Health/Media entries.
		renderToday(
			[todo("t_due", "Pay rent", { due_at: PAST })],
			[project("p1", "Migration")],
		);
		expect(
			(await screen.findByRole("link", { name: /health/i })).getAttribute(
				"href",
			),
		).toContain("/library/health");
		expect(
			screen.getByRole("link", { name: /media/i }).getAttribute("href"),
		).toContain("/library/media");
	});

	it("renders honest digest copy (no fabricated stats)", async () => {
		renderToday([todo("t_due", "Pay rent", { due_at: PAST })]);
		await screen.findByRole("link", { name: /health/i });
		// Health is still a stub ("coming soon"); Media is now live (ADR-0059), so its
		// card names what the topic holds. Neither invents a count (ADR-0054 dec.5).
		expect(screen.getAllByText(/coming soon/i).length).toBe(1);
		expect(screen.getByText(/tracking — coming soon/i)).toBeInTheDocument();
		expect(screen.getByText(/your read & watch queue/i)).toBeInTheDocument();
	});

	it("keeps the In-focus and Recently-captured sections on a populated landing", async () => {
		// Only Due-soon was guarded before. Seed an active project (drives In focus)
		// plus the due todo, and assert the other two GTD home sections still render.
		renderToday(
			[todo("t_due", "Pay rent", { due_at: PAST })],
			[project("p1", "Migration")],
		);
		expect(await screen.findByText("In focus")).toBeInTheDocument();
		expect(screen.getByText("Recently captured")).toBeInTheDocument();
		// The seeded project surfaces in the In-focus list.
		expect(screen.getAllByText("Migration").length).toBeGreaterThan(0);
	});
});
