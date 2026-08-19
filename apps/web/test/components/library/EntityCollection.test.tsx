import type { EntityListResult } from "@inkstone/protocol";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import {
	journalEntryRow,
	mediaRow,
	personRow,
	projectRow,
} from "@test/test-utils/rows";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityCollection } from "@/components/library/EntityCollection";
import type { LibraryItemKind } from "@/lib/libraryItems";

// Live People rows the stub serves for `type === "person"` (no static preview people merged in).
const livePeople: EntityListResult["entities"] = [
	personRow(
		"01900000-0000-7000-8000-0000000000a1",
		"Ada Lovelace",
		{ note: "met at the analytical engine demo" },
		{ created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
	),
	personRow("01900000-0000-7000-8000-0000000000a2", "Grace Hopper"),
];

function renderCollection(
	kind: LibraryItemKind,
	rows: {
		journalEntries?: EntityListResult["entities"];
		people?: EntityListResult["entities"];
		projects?: EntityListResult["entities"];
		media?: EntityListResult["entities"];
	},
	overrides?: {
		selectedId?: string | null;
		onSelect?: (id: string) => void;
		onNew?: () => void;
	},
) {
	return renderWithCore(
		<EntityCollection
			kind={kind}
			selectedId={overrides?.selectedId ?? null}
			onSelect={overrides?.onSelect ?? (() => {})}
			onNew={overrides?.onNew}
		/>,
		{
			entities: {
				person: rows.people ?? [],
				journal_entry: rows.journalEntries ?? [],
				project: rows.projects ?? [],
				media: rows.media ?? [],
			},
		},
	);
}

afterEach(cleanup);

describe("EntityCollection", () => {
	it("lists live Media read from entity/list", async () => {
		renderCollection("media", {
			media: [
				mediaRow(
					"01900000-0000-7000-8000-0000000000e1",
					"Effect docs",
					"link",
					"done",
					{
						url: "https://effect.website",
					},
				),
			],
		});

		expect(await screen.findByText("Effect docs")).toBeInTheDocument();
	});

	it("lists live People read from entity/list (preview people no longer merged)", async () => {
		renderCollection("person", { people: livePeople });
		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		// The static preview person is gone.
		expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
	});

	it("surfaces the error state when any one entity read fails (all-or-nothing)", async () => {
		// `useLibraryItems` reads all four types in one `Effect.all`; a single
		// failing read rejects the whole program. The hook now lets that rejection
		// surface as the query's `isError` (rather than swallowing it to []), so the
		// view shows the distinct "Couldn't load" state — NOT a misleading empty
		// Library that looks identical to a brand-new workspace.
		await renderWithCore(
			<EntityCollection
				kind="person"
				selectedId={null}
				onSelect={() => {}}
				onNew={() => {}}
			/>,
			{
				overrides: {
					listEntities: (type) =>
						type === "project"
							? Effect.die("project read failed")
							: type === "person"
								? Effect.succeed({ entities: livePeople })
								: Effect.succeed({ entities: [] }),
				},
			},
		);

		// The "Couldn't load" error state renders — not the otherwise-loadable
		// People rows, and not the misleading "No people yet" empty state.
		expect(
			await screen.findByText(/couldn't load people/i),
		).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
		expect(screen.queryByText("No people yet")).not.toBeInTheDocument();
		// The header count is hidden (a "0" would contradict "Couldn't load"), and
		// New is suppressed (its editor's relation pickers source the failed list).
		expect(screen.queryByText("0")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /new person/i }),
		).not.toBeInTheDocument();
	});

	it("filters as you search", async () => {
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople });
		await screen.findByText("Grace Hopper");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"grace",
		);

		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
	});

	it("teaches an empty result instead of going blank", async () => {
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople });
		await screen.findByText("Ada Lovelace");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"zzznobody",
		);

		expect(
			screen.getByText(/no people match your filters/i),
		).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
	});

	it("reports the selected row id", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople }, { onSelect });
		await screen.findByText("Ada Lovelace");

		await user.click(screen.getByRole("button", { name: /ada lovelace/i }));
		expect(onSelect).toHaveBeenCalledWith(
			"01900000-0000-7000-8000-0000000000a1",
		);
	});

	it("offers a New action that opens a blank editor", async () => {
		const onNew = vi.fn();
		const user = userEvent.setup();
		renderCollection(
			"project",
			{
				projects: [
					projectRow("01900000-0000-7000-8000-000000000031", "Apollo"),
				],
			},
			{ onNew },
		);
		await screen.findByText("Apollo");

		await user.click(screen.getByRole("button", { name: /new project/i }));
		expect(onNew).toHaveBeenCalledTimes(1);
	});

	it("groups Journal Entries by occurred day and orders rows by occurred time", async () => {
		renderCollection("journal_entry", {
			journalEntries: [
				journalEntryRow(
					"01900000-0000-7000-8000-0000000000c1",
					[{ type: "text", text: "Evening retro" }],
					{ occurred_at: "2026-06-10T18:30:00" },
					{ created_at: 1_700_000_300_000, updated_at: 1_700_000_300_000 },
				),
				journalEntryRow(
					"01900000-0000-7000-8000-0000000000c2",
					[{ type: "text", text: "Morning sync" }],
					{ occurred_at: "2026-06-10T09:00:00" },
					{ created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
				),
				journalEntryRow(
					"01900000-0000-7000-8000-0000000000c3",
					[{ type: "text", text: "Next day note" }],
					{ occurred_at: "2026-06-11T08:00:00" },
				),
			],
		});

		expect(await screen.findByText("Next day note")).toBeInTheDocument();
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual(["2026-06-11", "2026-06-10"]);

		const morning = screen.getByText("Morning sync");
		const evening = screen.getByText("Evening retro");
		expect(
			morning.compareDocumentPosition(evening) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("lists mixed Journal Entry bodies using resolved ref labels in order", async () => {
		renderCollection("journal_entry", {
			journalEntries: [
				journalEntryRow(
					"01900000-0000-7000-8000-0000000000d1",
					[
						{ type: "text", text: "Met " },
						{
							type: "entity_ref",
							ref_id: "01900000-0000-7000-8000-0000000000f1",
						},
						{ type: "text", text: " at school." },
					],
					{ occurred_at: "2026-06-10T18:30:00" },
					{
						refs: [
							{
								id: "01900000-0000-7000-8000-0000000000f1",
								source_entity_id: "01900000-0000-7000-8000-0000000000d1",
								target_entity_id: "01900000-0000-7000-8000-0000000000a1",
								target_entity_type: "person",
								target_title: "Ada Lovelace",
								label_snapshot: "Ada",
							},
						],
						created_at: 1_700_000_300_000,
						updated_at: 1_700_000_300_000,
					},
				),
			],
		});

		expect(
			await screen.findByText("Met Ada Lovelace at school."),
		).toBeInTheDocument();
	});

	// --- Facets (Status, on the Project surface) ---

	// Three projects spanning distinct statuses so the Status facet can partition.
	const mixedStatusProjects: EntityListResult["entities"] = [
		projectRow("st-active", "Active project", { status: "active" }),
		projectRow("st-done", "Completed project", {
			status: "completed",
			completed_at: "2026-06-01T00:00:00",
		}),
		projectRow("st-hold", "On hold project", { status: "on_hold" }),
	];

	// Facet chips share label text with row titles ("Active project" vs the "Active"
	// chip), so scope chip queries to the labelled Filters group.
	const filters = () => within(screen.getByRole("group", { name: /filters/i }));

	it("shows a Status facet group only when the kind has >=2 distinct statuses", async () => {
		renderCollection("project", { projects: mixedStatusProjects });
		await screen.findByText("Active project");
		// The group label and one chip per present status.
		expect(screen.getByText("Status")).toBeInTheDocument();
		expect(
			filters().getByRole("button", { name: /^Active/ }),
		).toBeInTheDocument();
		expect(
			filters().getByRole("button", { name: /^Completed/ }),
		).toBeInTheDocument();
	});

	it("does not show a Status facet group when all rows share one status", async () => {
		renderCollection("project", {
			projects: [
				projectRow("a1", "Only active one", { status: "active" }),
				projectRow("a2", "Only active two", { status: "active" }),
			],
		});
		await screen.findByText("Only active one");
		// A single-value facet can't partition → no group, no label.
		expect(screen.queryByText("Status")).not.toBeInTheDocument();
	});

	it("filters rows when a status chip is selected and restores when cleared", async () => {
		const user = userEvent.setup();
		renderCollection("project", { projects: mixedStatusProjects });
		await screen.findByText("Active project");

		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		expect(screen.getByText("Completed project")).toBeInTheDocument();
		expect(screen.queryByText("Active project")).not.toBeInTheDocument();
		expect(screen.queryByText("On hold project")).not.toBeInTheDocument();

		// Clicking the chip again clears it → all rows return.
		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		expect(screen.getByText("Active project")).toBeInTheDocument();
		expect(screen.getByText("On hold project")).toBeInTheDocument();
	});

	it("composes a status facet with the text query", async () => {
		const user = userEvent.setup();
		renderCollection("project", {
			projects: [
				projectRow("q1", "Alpha active", { status: "active" }),
				projectRow("q2", "Beta active", { status: "active" }),
				projectRow("q3", "Alpha completed", {
					status: "completed",
					completed_at: "2026-06-01T00:00:00",
				}),
			],
		});
		await screen.findByText("Alpha active");

		await user.type(
			screen.getByRole("textbox", { name: /search projects/i }),
			"alpha",
		);
		// Query alone keeps both Alphas.
		expect(screen.getByText("Alpha active")).toBeInTheDocument();
		expect(screen.getByText("Alpha completed")).toBeInTheDocument();
		expect(screen.queryByText("Beta active")).not.toBeInTheDocument();

		// Adding Status=active narrows to the active Alpha only (AND).
		await user.click(filters().getByRole("button", { name: /^Active/ }));
		expect(screen.getByText("Alpha active")).toBeInTheDocument();
		expect(screen.queryByText("Alpha completed")).not.toBeInTheDocument();
	});

	it("teaches an empty-after-filter state with a Reset that clears facets and query", async () => {
		const user = userEvent.setup();
		renderCollection("project", {
			projects: [
				projectRow("e1", "Findable active", { status: "active" }),
				projectRow("e2", "Other completed", {
					status: "completed",
					completed_at: "2026-06-01T00:00:00",
				}),
			],
		});
		await screen.findByText("Findable active");

		// Filter to Completed (keeps "Other completed"), THEN type a query that the
		// completed row doesn't match → empty. (Querying first would zero the
		// Completed chip's leave-one-out count and hide it, so order matters.)
		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		await user.type(
			screen.getByRole("textbox", { name: /search projects/i }),
			"findable",
		);
		expect(
			screen.getByText(/no projects match your filters/i),
		).toBeInTheDocument();

		// Reset restores the full list (clears BOTH the query and the facet).
		await user.click(screen.getByRole("button", { name: /^reset/i }));
		expect(screen.getByText("Findable active")).toBeInTheDocument();
		expect(screen.getByText("Other completed")).toBeInTheDocument();
		expect(
			screen.getByRole<HTMLInputElement>("textbox", {
				name: /search projects/i,
			}).value,
		).toBe("");
	});

	it("renders no facet row for kinds without facets (people)", async () => {
		renderCollection("person", { people: livePeople });
		await screen.findByText("Ada Lovelace");
		// The whole Filters group is absent (the "People" <h1> collection title is
		// not a facet — assert on the group, not on stray label text).
		expect(
			screen.queryByRole("group", { name: /filters/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Status")).not.toBeInTheDocument();
	});

	it("drops a malformed live Journal Entry row but still renders the valid ones (slice-3)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		renderCollection("journal_entry", {
			journalEntries: [
				{
					// Malformed: no `occurred_at` — the strict parser throws on this row.
					// Stays an inline literal: journalEntryRow always defaults occurred_at,
					// so the builder can't express this deliberately broken shape.
					id: "01900000-0000-7000-8000-0000000000b1",
					type: "journal_entry",
					data: { body: [{ type: "text", text: "missing occurred time" }] },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
				// Valid sibling — must survive even though the row above is dropped.
				journalEntryRow(
					"01900000-0000-7000-8000-0000000000b2",
					[{ type: "text", text: "valid entry survives" }],
					{ occurred_at: "2026-06-10T09:00:00" },
					{ created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
				),
			],
		});

		// The valid entry renders (the Library is NOT blanked by the bad row), and
		// the "Couldn't load" error state never appears.
		expect(await screen.findByText("valid entry survives")).toBeInTheDocument();
		expect(
			screen.queryByText(/couldn't load journal/i),
		).not.toBeInTheDocument();
		expect(screen.queryByText("missing occurred time")).not.toBeInTheDocument();
		// The dropped row left a browser console.warn so it isn't lost silently.
		expect(warn).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
	});
});
