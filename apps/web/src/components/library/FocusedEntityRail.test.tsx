import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { assembleLibraryItems } from "@/lib/hooks/useLibraryItems";
import { RuntimeProvider } from "@/runtime";
import { FocusedEntityRail } from "./FocusedEntityRail";
import { type TimelineFilter, TimelineView } from "./TimelineView";

type Rows = EntityListResult["entities"];

/** A journal-entry row whose body references one entity (person or project). */
const jeRef = (
	id: string,
	occurredAt: string,
	text: string,
	targetId: string,
	targetType: "person" | "project",
	targetTitle: string,
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
			target_entity_id: targetId,
			target_entity_type: targetType,
			target_title: targetTitle,
		},
	],
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

/** A person row so the rail can resolve the focused entity's name + kind. */
const person = (id: string, name: string): Rows[number] => ({
	id,
	type: "person",
	data: { name },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

/** Maya referenced by two JEs across two days; a third JE touches only a project. */
const SEED: Rows = [
	person("maya", "Maya"),
	jeRef(
		"je_a",
		"2026-06-10T09:00:00",
		"Synced with ",
		"maya",
		"person",
		"Maya",
	),
	jeRef(
		"je_b",
		"2026-06-12T14:00:00",
		"Standup with ",
		"maya",
		"person",
		"Maya",
	),
	jeRef(
		"je_proj",
		"2026-06-11T11:00:00",
		"Kicked off ",
		"proj_apiv2",
		"project",
		"API v2",
	),
];

/** Assemble the seed rows into the Library view model the rail consumes. */
function seedItems() {
	return assembleLibraryItems({
		journalEntries: SEED.filter((r) => r.type === "journal_entry"),
		people: SEED.filter((r) => r.type === "person"),
		projects: [],
		todos: [],
		media: [],
	});
}

function makeRuntime(rows: Rows) {
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
			Effect.succeed({ entities: rows.filter((r) => r.type === type) }),
		getBacklinks: () => unused,
		observationQuery: () => unused,
		observationUpdate: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		providerConfigure: () => unused,
		providerTest: () => unused,
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

function withProviders(rows: Rows) {
	const runtime = makeRuntime(rows);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return Wrapper;
}

/** Render a node under the Runtime + Query providers (neither the rail nor the feed
 * touches the router — chips are focus buttons, not `<Link>`s, as of slice 5b). */
function mount(node: ReactNode, Wrapper: ReturnType<typeof withProviders>) {
	return render(node, { wrapper: Wrapper });
}

afterEach(cleanup);

describe("FocusedEntityRail", () => {
	it("shows the entity name + the lens note + only its referencing JEs", () => {
		const items = seedItems();
		const Wrapper = withProviders(SEED);
		mount(
			<FocusedEntityRail entityId="maya" items={items} onClose={() => {}} />,
			Wrapper,
		);

		// The rail is labelled as the focused entity.
		expect(screen.getByText("Maya")).toBeInTheDocument();
		// The "same entity, different lens" note distinguishes this from the GTD lens.
		expect(screen.getByText(/interaction history/i)).toBeInTheDocument();

		// Exactly the two Maya-referencing JE excerpts; the project-only JE is absent.
		expect(screen.getByText("Synced with Maya")).toBeInTheDocument();
		expect(screen.getByText("Standup with Maya")).toBeInTheDocument();
		expect(screen.queryByText("Kicked off API v2")).not.toBeInTheDocument();
	});

	it("the close affordance fires onClose", async () => {
		const items = seedItems();
		let closed = false;
		const Wrapper = withProviders(SEED);
		mount(
			<FocusedEntityRail
				entityId="maya"
				items={items}
				onClose={() => {
					closed = true;
				}}
			/>,
			Wrapper,
		);
		await userEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(closed).toBe(true);
	});
});

/** Drives the controlled TimelineView, tracking the focus selection locally. */
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

describe("TimelineView focus rail", () => {
	it("clicking a person chip opens the rail; closing it clears the focus", async () => {
		const Wrapper = withProviders(SEED);
		mount(<StatefulTimeline />, Wrapper);

		// Both Maya entries surface in the feed first.
		await screen.findByText("Synced with Maya");
		// No rail yet (its lens note is absent).
		expect(screen.queryByText(/interaction history/i)).not.toBeInTheDocument();

		// Clicking Maya's chip in the feed opens her focus rail.
		const chips = await screen.findAllByRole("button", { name: "Maya" });
		await userEvent.click(chips[0]);

		// The rail's lens note appears, and the project-only JE never enters it.
		expect(await screen.findByText(/interaction history/i)).toBeInTheDocument();
		const railRegion = screen.getByRole("complementary", { name: /Maya/i });
		expect(railRegion).toBeInTheDocument();

		// Closing the rail clears focus — the lens note is gone again.
		await userEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(screen.queryByText(/interaction history/i)).not.toBeInTheDocument();
	});
});
