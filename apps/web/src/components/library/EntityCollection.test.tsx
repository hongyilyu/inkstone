import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryItemKind } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { EntityCollection } from "./EntityCollection";

// Live People rows the stub serves for `type === "person"` (no static preview people merged in).
const livePeople: EntityListResult["entities"] = [
	{
		id: "01900000-0000-7000-8000-0000000000a1",
		type: "person",
		data: { name: "Ada Lovelace", note: "met at the analytical engine demo" },
		created_at: 1_700_000_100_000,
		updated_at: 1_700_000_100_000,
	},
	{
		id: "01900000-0000-7000-8000-0000000000a2",
		type: "person",
		data: { name: "Grace Hopper" },
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
	},
];

// Stub WsClient whose `entity/list` answers by type; unused methods die if exercised.
function makeRuntime(
	people: EntityListResult["entities"],
	todos: EntityListResult["entities"],
	journalEntries: EntityListResult["entities"],
	projects: EntityListResult["entities"] = [],
	bookmarks: EntityListResult["entities"] = [],
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: (type) => {
			if (type === "person") return Effect.succeed({ entities: people });
			if (type === "todo") return Effect.succeed({ entities: todos });
			if (type === "journal_entry") {
				return Effect.succeed({ entities: journalEntries });
			}
			if (type === "project") return Effect.succeed({ entities: projects });
			if (type === "bookmark") return Effect.succeed({ entities: bookmarks });
			return Effect.succeed({ entities: [] });
		},
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderCollection(
	kind: LibraryItemKind,
	rows: {
		journalEntries?: EntityListResult["entities"];
		people?: EntityListResult["entities"];
		todos?: EntityListResult["entities"];
		projects?: EntityListResult["entities"];
		bookmarks?: EntityListResult["entities"];
	},
	overrides?: {
		selectedId?: string | null;
		onSelect?: (id: string) => void;
		onNew?: () => void;
	},
) {
	const runtime = makeRuntime(
		rows.people ?? [],
		rows.todos ?? [],
		rows.journalEntries ?? [],
		rows.projects ?? [],
		rows.bookmarks ?? [],
	);
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
	return render(
		<EntityCollection
			kind={kind}
			selectedId={overrides?.selectedId ?? null}
			onSelect={overrides?.onSelect ?? (() => {})}
			onNew={overrides?.onNew}
		/>,
		{ wrapper: Wrapper },
	);
}

afterEach(cleanup);

describe("EntityCollection", () => {
	it("lists live Bookmarks read from entity/list", async () => {
		renderCollection("bookmark", {
			bookmarks: [
				{
					id: "01900000-0000-7000-8000-0000000000e1",
					type: "bookmark",
					data: { title: "Effect docs", url: "https://effect.website" },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
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
		// `useLibraryItems` reads all five types in one `Effect.all`; a single
		// failing read rejects the whole program. The hook now lets that rejection
		// surface as the query's `isError` (rather than swallowing it to []), so the
		// view shows the distinct "Couldn't load" state — NOT a misleading empty
		// Library that looks identical to a brand-new workspace.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: (type) =>
				type === "todo"
					? Effect.die("todo read failed")
					: type === "person"
						? Effect.succeed({ entities: livePeople })
						: Effect.succeed({ entities: [] }),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun: () => Effect.die("unused"),
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Effect.die("unused"),
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const client = new QueryClient({
			defaultOptions: {
				queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
			},
		});
		render(
			<EntityCollection
				kind="person"
				selectedId={null}
				onSelect={() => {}}
				onNew={() => {}}
			/>,
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>
						<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
					</QueryClientProvider>
				),
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

	it("renders live Todos read from entity/list", async () => {
		renderCollection("todo", {
			todos: [
				{
					id: "01900000-0000-7000-8000-000000000030",
					type: "todo",
					data: { title: "buy milk", status: "active" },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
			],
		});
		expect(await screen.findByText("buy milk")).toBeInTheDocument();
		// Preview Todos are not shown — Todos are live for this read.
		expect(
			screen.queryByText("Backfill /v2/contacts before the cutover window"),
		).not.toBeInTheDocument();
	});

	it("orders todos active-first, then earliest due, undated last", async () => {
		const mk = (id: string, title: string, data: Record<string, unknown>) => ({
			id,
			type: "todo" as const,
			data: { title, ...data },
			created_at: 1_700_000_000_000,
			updated_at: 1_700_000_000_000,
		});
		renderCollection("todo", {
			todos: [
				mk("done", "Zed completed", { status: "completed" }),
				mk("undated", "Active no due", { status: "active" }),
				mk("late", "Active due later", {
					status: "active",
					due_at: "2026-06-20T00:00:00",
				}),
				mk("soon", "Active due soon", {
					status: "active",
					due_at: "2026-06-13T00:00:00",
				}),
			],
		});

		await screen.findByText("Active due soon");
		// Scope to the row list — a "Status" facet chip also reads "Active", so an
		// unscoped /^Active/ would pick it up alongside the row titles.
		const { getAllByText } = within(screen.getByRole("list"));
		const titles = getAllByText(/^(Active|Zed)/).map((el) => el.textContent);
		// Active dated (soon before late) → active undated → completed last.
		expect(titles).toEqual([
			"Active due soon",
			"Active due later",
			"Active no due",
			"Zed completed",
		]);
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
			"todo",
			{
				todos: [
					{
						id: "01900000-0000-7000-8000-000000000031",
						type: "todo",
						data: { title: "existing", status: "active" },
						created_at: 1_700_000_000_000,
						updated_at: 1_700_000_000_000,
					},
				],
			},
			{ onNew },
		);
		await screen.findByText("existing");

		await user.click(screen.getByRole("button", { name: /new todo/i }));
		expect(onNew).toHaveBeenCalledTimes(1);
	});

	it("groups Journal Entries by occurred day and orders rows by occurred time", async () => {
		renderCollection("journal_entry", {
			journalEntries: [
				{
					id: "01900000-0000-7000-8000-0000000000c1",
					type: "journal_entry",
					data: {
						occurred_at: "2026-06-10T18:30:00",
						body: [{ type: "text", text: "Evening retro" }],
					},
					created_at: 1_700_000_300_000,
					updated_at: 1_700_000_300_000,
				},
				{
					id: "01900000-0000-7000-8000-0000000000c2",
					type: "journal_entry",
					data: {
						occurred_at: "2026-06-10T09:00:00",
						body: [{ type: "text", text: "Morning sync" }],
					},
					created_at: 1_700_000_100_000,
					updated_at: 1_700_000_100_000,
				},
				{
					id: "01900000-0000-7000-8000-0000000000c3",
					type: "journal_entry",
					data: {
						occurred_at: "2026-06-11T08:00:00",
						body: [{ type: "text", text: "Next day note" }],
					},
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
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
				{
					id: "01900000-0000-7000-8000-0000000000d1",
					type: "journal_entry",
					data: {
						occurred_at: "2026-06-10T18:30:00",
						body: [
							{ type: "text", text: "Met " },
							{
								type: "entity_ref",
								ref_id: "01900000-0000-7000-8000-0000000000f1",
							},
							{ type: "text", text: " at school." },
						],
					},
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
			],
		});

		expect(
			await screen.findByText("Met Ada Lovelace at school."),
		).toBeInTheDocument();
	});

	// --- Facets (slice-2: Status) ---

	const mkTodo = (
		id: string,
		title: string,
		data: Record<string, unknown>,
	) => ({
		id,
		type: "todo" as const,
		data: { title, ...data },
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
	});

	// Three todos spanning active/completed/dropped so the Status facet can partition.
	const mixedStatusTodos: EntityListResult["entities"] = [
		mkTodo("st-active", "Active todo", { status: "active" }),
		mkTodo("st-done", "Completed todo", { status: "completed" }),
		mkTodo("st-dropped", "Dropped todo", { status: "dropped" }),
	];

	// Facet chips share label text with row titles ("Active todo" vs the "Active"
	// chip), so scope chip queries to the labelled Filters group.
	const filters = () => within(screen.getByRole("group", { name: /filters/i }));

	it("shows a Status facet group only when the kind has >=2 distinct statuses", async () => {
		renderCollection("todo", { todos: mixedStatusTodos });
		await screen.findByText("Active todo");
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
		renderCollection("todo", {
			todos: [
				mkTodo("a1", "Only active one", { status: "active" }),
				mkTodo("a2", "Only active two", { status: "active" }),
			],
		});
		await screen.findByText("Only active one");
		// A single-value facet can't partition → no group, no label.
		expect(screen.queryByText("Status")).not.toBeInTheDocument();
	});

	it("filters rows when a status chip is selected and restores when cleared", async () => {
		const user = userEvent.setup();
		renderCollection("todo", { todos: mixedStatusTodos });
		await screen.findByText("Active todo");

		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		expect(screen.getByText("Completed todo")).toBeInTheDocument();
		expect(screen.queryByText("Active todo")).not.toBeInTheDocument();
		expect(screen.queryByText("Dropped todo")).not.toBeInTheDocument();

		// Clicking the active chip again clears it → all rows return.
		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		expect(screen.getByText("Active todo")).toBeInTheDocument();
		expect(screen.getByText("Dropped todo")).toBeInTheDocument();
	});

	it("composes a status facet with the text query", async () => {
		const user = userEvent.setup();
		renderCollection("todo", {
			todos: [
				mkTodo("q1", "Alpha active", { status: "active" }),
				mkTodo("q2", "Beta active", { status: "active" }),
				mkTodo("q3", "Alpha completed", { status: "completed" }),
			],
		});
		await screen.findByText("Alpha active");

		await user.type(
			screen.getByRole("textbox", { name: /search todos/i }),
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
		renderCollection("todo", {
			todos: [
				mkTodo("e1", "Findable active", { status: "active" }),
				mkTodo("e2", "Other completed", { status: "completed" }),
			],
		});
		await screen.findByText("Findable active");

		// Filter to Completed (keeps "Other completed"), THEN type a query that the
		// completed row doesn't match → empty. (Querying first would zero the
		// Completed chip's leave-one-out count and hide it, so order matters.)
		await user.click(filters().getByRole("button", { name: /^Completed/ }));
		await user.type(
			screen.getByRole("textbox", { name: /search todos/i }),
			"findable",
		);
		expect(
			screen.getByText(/no todos match your filters/i),
		).toBeInTheDocument();

		// Reset restores the full list (clears BOTH the query and the facet).
		await user.click(screen.getByRole("button", { name: /^reset/i }));
		expect(screen.getByText("Findable active")).toBeInTheDocument();
		expect(screen.getByText("Other completed")).toBeInTheDocument();
		expect(
			(
				screen.getByRole("textbox", {
					name: /search todos/i,
				}) as HTMLInputElement
			).value,
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
					id: "01900000-0000-7000-8000-0000000000b1",
					type: "journal_entry",
					data: { body: [{ type: "text", text: "missing occurred time" }] },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
				{
					// Valid sibling — must survive even though the row above is dropped.
					id: "01900000-0000-7000-8000-0000000000b2",
					type: "journal_entry",
					data: {
						occurred_at: "2026-06-10T09:00:00",
						body: [{ type: "text", text: "valid entry survives" }],
					},
					created_at: 1_700_000_100_000,
					updated_at: 1_700_000_100_000,
				},
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
