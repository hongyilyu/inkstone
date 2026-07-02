import type { EntityListResult } from "@inkstone/protocol";
import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import {
	type TimelineFilter,
	TimelineView,
} from "@/components/library/TimelineView";

type Rows = EntityListResult["entities"];

/** Stub WsClient serving the given journal-entry rows; unused methods die. */
function makeRuntime(journalEntries: Rows) {
	const stub = stubWsClient({
		listEntities: (type) =>
			type === "journal_entry"
				? Effect.succeed({ entities: journalEntries })
				: Effect.succeed({ entities: [] }),
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

/** TimelineView's chips are plain buttons (they set `?focus=` via a callback),
 * so no router context is needed — render directly under the providers. */
function renderTimeline(journalEntries: Rows) {
	const runtime = makeRuntime(journalEntries);
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
	return render(<StatefulTimeline />, { wrapper: Wrapper });
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
	it("renders the four type filters", async () => {
		renderTimeline([je("je1", "2026-06-10T09:00:00", "Solo day")]);
		// Type filters are toggle buttons (aria-pressed), not ARIA tabs.
		for (const label of [/^all$/i, /journal/i, /people/i, /projects/i]) {
			expect(
				await screen.findByRole("button", { name: label }),
			).toBeInTheDocument();
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

		await userEvent.click(screen.getByRole("button", { name: /people/i }));

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

		await userEvent.click(screen.getByRole("button", { name: /journal/i }));

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

		await userEvent.click(screen.getByRole("button", { name: /projects/i }));

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

	it("distinguishes a filter that hid every entry from a truly empty timeline", async () => {
		// One entry, touching no person. Under All it shows; under People the filter
		// hides it, leaving zero visible days — but the timeline is NOT empty, so the
		// empty state must say "no entries match this filter", not "nothing yet".
		renderTimeline([
			je("je_solo", "2026-06-10T09:00:00", "Heads-down, no one mentioned"),
		]);
		await screen.findByText("Heads-down, no one mentioned");

		await userEvent.click(screen.getByRole("button", { name: /people/i }));

		expect(
			screen.getByText("No entries match this filter"),
		).toBeInTheDocument();
		// Must NOT claim the timeline is empty when it has an entry.
		expect(
			screen.queryByText("Nothing on the timeline yet"),
		).not.toBeInTheDocument();
	});
});
