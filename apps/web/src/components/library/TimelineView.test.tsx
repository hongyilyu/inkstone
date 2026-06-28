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
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { type TimelineFilter, TimelineView } from "./TimelineView";

type Rows = EntityListResult["entities"];

/** Stub WsClient serving the given journal-entry rows; unused methods die. */
function makeRuntime(journalEntries: Rows) {
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
		listEntities: (type) =>
			type === "journal_entry"
				? Effect.succeed({ entities: journalEntries })
				: Effect.succeed({ entities: [] }),
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

/** Drives the controlled TimelineView; clicking a tab flips `filter` locally and a
 * chip sets the focus selection. */
function StatefulTimeline() {
	const [filter, setFilter] = useState<TimelineFilter>("all");
	const [focus, setFocus] = useState<string | null>(null);
	return (
		<TimelineView
			filter={filter}
			onFilterChange={setFilter}
			focusEntityId={focus}
			onFocusChange={setFocus}
		/>
	);
}

/** Mount under a memory router so the chip `<Link>`s render as anchors. */
function renderTimeline(journalEntries: Rows) {
	const runtime = makeRuntime(journalEntries);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	const rootRoute = createRootRoute({ component: StatefulTimeline });
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

/** A journal-entry row with a plain-text body. */
const je = (id: string, occurredAt: string, text: string): Rows[number] => ({
	id,
	type: "journal_entry",
	data: { occurred_at: occurredAt, body: [{ type: "text", text }] },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

/** A journal-entry row whose body references one person, resolved via `refs`. */
const jeWithPerson = (
	id: string,
	occurredAt: string,
	text: string,
	personId: string,
	personName: string,
): Rows[number] => ({
	id,
	type: "journal_entry",
	data: {
		occurred_at: occurredAt,
		body: [
			{ type: "text", text },
			{ type: "entity_ref", ref_id: `${id}_r1` },
		],
	},
	refs: [
		{
			id: `${id}_r1`,
			source_entity_id: id,
			target_entity_id: personId,
			target_entity_type: "person",
			target_title: personName,
		},
	],
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

/** A journal-entry row whose body references one project, resolved via `refs`. */
const jeWithProject = (
	id: string,
	occurredAt: string,
	text: string,
	projectId: string,
	projectName: string,
): Rows[number] => ({
	id,
	type: "journal_entry",
	data: {
		occurred_at: occurredAt,
		body: [
			{ type: "text", text },
			{ type: "entity_ref", ref_id: `${id}_r1` },
		],
	},
	refs: [
		{
			id: `${id}_r1`,
			source_entity_id: id,
			target_entity_id: projectId,
			target_entity_type: "project",
			target_title: projectName,
		},
	],
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

afterEach(cleanup);

describe("TimelineView", () => {
	it("renders the four type tabs as a tablist", async () => {
		renderTimeline([je("je1", "2026-06-10T09:00:00", "Solo day")]);
		const tabs = await screen.findAllByRole("tab");
		const labels = tabs.map((t) => t.textContent);
		for (const label of ["All", "Journal", "People", "Projects"]) {
			expect(labels.some((l) => l?.includes(label))).toBe(true);
		}
	});

	it("renders a day header and the JE excerpt + its person chip", async () => {
		renderTimeline([
			jeWithPerson(
				"je_priya",
				"2026-06-10T09:00:00",
				"Synced with ",
				"person_priya",
				"Priya",
			),
		]);
		// Excerpt concatenates text + the chip title via journalEntryBodyText.
		expect(await screen.findByText("Synced with Priya")).toBeInTheDocument();
		// The person chip is a focus control (slice 5b): clicking it opens the
		// entity's lens rail rather than jumping to its collection.
		const chip = screen.getByRole("button", { name: "Priya" });
		expect(chip).toBeInTheDocument();
	});

	it("the People tab hides a JE with no person reference", async () => {
		renderTimeline([
			jeWithPerson(
				"je_priya",
				"2026-06-10T09:00:00",
				"Synced with ",
				"person_priya",
				"Priya",
			),
			je("je_solo", "2026-06-10T16:00:00", "Heads-down, no one mentioned"),
		]);
		await screen.findByText("Synced with Priya");
		// Both entries show under All.
		expect(
			screen.getByText("Heads-down, no one mentioned"),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: /people/i }));

		// The person-touching entry stays; the chip-less one is filtered out.
		expect(screen.getByText("Synced with Priya")).toBeInTheDocument();
		expect(
			screen.queryByText("Heads-down, no one mentioned"),
		).not.toBeInTheDocument();
	});

	it("the Journal tab keeps entries but hides their chips", async () => {
		renderTimeline([
			jeWithPerson(
				"je_priya",
				"2026-06-10T09:00:00",
				"Synced with ",
				"person_priya",
				"Priya",
			),
		]);
		// Under All the chip is present.
		expect(
			await screen.findByRole("button", { name: "Priya" }),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: /journal/i }));

		// The entry excerpt stays; chipsForFilter returns [] for "journal", so the
		// chip is gone (a regression that kept chips would fail here).
		expect(screen.getByText("Synced with Priya")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Priya" }),
		).not.toBeInTheDocument();
	});

	it("the Projects tab shows only entries with a project reference", async () => {
		renderTimeline([
			jeWithProject(
				"je_apiv2",
				"2026-06-10T09:00:00",
				"Kicked off ",
				"proj_apiv2",
				"API v2",
			),
			jeWithPerson(
				"je_priya",
				"2026-06-10T16:00:00",
				"Synced with ",
				"person_priya",
				"Priya",
			),
		]);
		await screen.findByText("Kicked off API v2");
		// Both entries show under All.
		expect(screen.getByText("Synced with Priya")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: /projects/i }));

		// The project-touching entry stays (with its project chip); the person-only
		// entry is filtered out (a regression that ignored kind would keep it).
		expect(screen.getByText("Kicked off API v2")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "API v2" })).toBeInTheDocument();
		expect(screen.queryByText("Synced with Priya")).not.toBeInTheDocument();
	});

	it("shows the empty state when there are no Journal Entries", async () => {
		renderTimeline([]);
		expect(
			await screen.findByText("Nothing on the timeline yet"),
		).toBeInTheDocument();
	});
});
