import type { EntityListResult } from "@inkstone/protocol";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { journalEntryRow, personRow } from "@test/test-utils/rows";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FocusedEntityRail } from "@/components/library/FocusedEntityRail";
import {
	type TimelineFilter,
	TimelineView,
} from "@/components/library/TimelineView";
import { assembleLibraryItems } from "@/lib/hooks/useLibraryItems";

type Rows = EntityListResult["entities"];

/** A journal-entry row whose body references one entity (person or project). */
const jeRef = (
	id: string,
	occurredAt: string,
	text: string,
	targetId: string,
	targetType: "person" | "project",
	targetTitle: string,
): Rows[number] =>
	journalEntryRow(
		id,
		[
			{ type: "text", text },
			{ type: "entity_ref", ref_id: `${id}_r1` },
		],
		{ occurred_at: occurredAt },
		{
			refs: [
				{
					id: `${id}_r1`,
					source_entity_id: id,
					target_entity_id: targetId,
					target_entity_type: targetType,
					target_title: targetTitle,
				},
			],
		},
	);

/** Maya referenced by two JEs across two days; a third JE touches only a project. */
const SEED: Rows = [
	personRow("maya", "Maya"),
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

/** Render a node under the shared Core harness seeded with `rows` (neither the
 * rail nor the feed touches the router — chips are focus buttons, not `<Link>`s,
 * as of slice 5b). */
function mount(node: ReactElement, rows: Rows) {
	return renderWithCore(node, {
		entities: {
			journal_entry: rows.filter((r) => r.type === "journal_entry"),
			person: rows.filter((r) => r.type === "person"),
		},
	});
}

afterEach(cleanup);

describe("FocusedEntityRail", () => {
	it("shows the entity name + the lens note + only its referencing JEs", async () => {
		const items = seedItems();
		await mount(
			<FocusedEntityRail entityId="maya" items={items} onClose={() => {}} />,
			SEED,
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
		await mount(
			<FocusedEntityRail
				entityId="maya"
				items={items}
				onClose={() => {
					closed = true;
				}}
			/>,
			SEED,
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
		await mount(<StatefulTimeline />, SEED);

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
