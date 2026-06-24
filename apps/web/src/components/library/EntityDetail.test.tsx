import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	type RenderResult,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatDateTime,
	formatDay,
	type JournalEntry,
	type LibraryItem,
	type Person,
	type Project,
	type Todo,
} from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { EntityDetail } from "./EntityDetail";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

// Match a humanized date badge locale-independently: the label is literal, the
// date is derived from the SAME `formatDay` the component uses (so an en-US or a
// fr-FR ICU runner both pass). Escapes the formatter's output (it can contain
// regex-special characters like a comma).
function dayBadge(label: string, iso: string): RegExp {
	const day = formatDay(iso).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${label}${day}`);
}

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigate,
	};
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
});

// Stub WsClient whose `entityMutate` runs the handler; unused methods die.
function makeRuntime(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate,
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

/** Render EntityDetail inside the runtime + QueryClient its edit/delete writes need. */
function renderDetail(
	ui: React.ReactElement,
	runtime: ReturnType<typeof makeRuntime> = makeRuntime(),
): RenderResult {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return render(ui, { wrapper: Wrapper });
}

const ada: Person = {
	id: "person_ada",
	kind: "person",
	name: "Ada Lovelace",
	note: "Current canonical name",
	createdAt: "fixture",
	recency: 2,
};

function journal(body: JournalEntry["body"]): JournalEntry {
	return {
		id: "journal_1",
		kind: "journal_entry",
		occurredAt: "2026-06-10T10:30:00",
		body,
		createdAt: "fixture",
		recency: 1,
	};
}

describe("EntityDetail Journal Entry body", () => {
	it("humanizes the Occurred at timestamp instead of leaking the raw ISO", () => {
		const entry = journal([{ type: "text", text: "Bought milk." }]);
		entry.occurredAt = "2026-06-19T14:30:00";
		renderDetail(<EntityDetail entity={entry} allEntities={[]} />);

		const occurred = screen.getByText("Occurred at")
			.nextElementSibling as HTMLElement;
		expect(occurred).not.toHaveTextContent("2026-06-19T14:30:00");
		expect(occurred.textContent).not.toContain("T");
		expect(occurred.textContent).not.toMatch(/:\d{2}:\d{2}/);
		expect(occurred).toHaveTextContent("19");
		// The exact humanized form, derived from the same formatter the component
		// uses — locale-independent (en-US "Jun 19, 2026, 2:30 PM", fr-FR differs).
		expect(occurred).toHaveTextContent(formatDateTime("2026-06-19T14:30:00"));
	});

	it("renders text-only Journal Entries normally", () => {
		renderDetail(
			<EntityDetail
				entity={journal([{ type: "text", text: "Bought milk." }])}
				allEntities={[]}
			/>,
		);

		expect(screen.getAllByText("Bought milk.")).toHaveLength(2);
	});

	it("renders mixed text and inline ref chips in order", () => {
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
					{ type: "text", text: " at school." },
				])}
				allEntities={[ada]}
			/>,
		);

		const body = screen.getByText("Body").nextElementSibling as HTMLElement;
		expect(body).toHaveTextContent("Met Ada Lovelace at school.");
		expect(
			within(body).getByRole("button", {
				name: "Ada Lovelace",
			}),
		).toBeInTheDocument();
	});

	it("falls back to label_snapshot when the target is not loaded", () => {
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: "missing_person",
						targetKind: "person",
						labelSnapshot: "Ada snapshot",
					},
				])}
				allEntities={[]}
			/>,
		);

		expect(screen.getByText("Ada snapshot")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Ada snapshot" }),
		).not.toBeInTheDocument();
	});

	it("opens a resolvable ref in the Library detail rail", async () => {
		const user = userEvent.setup();
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
				])}
				allEntities={[ada]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));

		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "people" },
			search: { id: "person_ada" },
		});
	});
});

// ── Slice 8: GTD detail projections ──────────────────────────────────────────

const person = (
	id: string,
	name: string,
	extra: Partial<Person> = {},
): Person => ({
	id,
	kind: "person",
	name,
	recency: 1,
	createdAt: "fixture",
	...extra,
});

const project = (
	id: string,
	name: string,
	extra: Partial<Project> = {},
): Project => ({
	id,
	kind: "project",
	name,
	status: "active",
	recency: 1,
	createdAt: "fixture",
	...extra,
});

const todoItem = (id: string, extra: Partial<Todo> = {}): Todo => ({
	id,
	kind: "todo",
	title: id,
	status: "active",
	personRefs: [],
	recency: 1,
	createdAt: "fixture",
	...extra,
});

describe("EntityDetail Todo projection", () => {
	it("shows status, dates, project, and linked people with role labels", () => {
		const alice = person("p_alice", "Alice");
		const proj = project("pr_1", "Daycare move");
		const todo = todoItem("t_1", {
			title: "Send Alice the schedule",
			status: "active",
			dueAt: "2999-06-14T17:00:00",
			deferAt: "2999-06-10T00:00:00",
			projectId: "pr_1",
			personRefs: [{ personId: "p_alice", role: "waiting_on" }],
		});
		const all: LibraryItem[] = [alice, proj, todo];

		renderDetail(<EntityDetail entity={todo} allEntities={all} />);

		// Status + due also appear in the header subtitle, so allow >1.
		expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1);
		// The inspector badge humanizes the day through `formatDay` (e.g. "Jun 14,
		// 2999" in en-US) — derive the expected text from the same formatter so the
		// assertion holds on any ICU locale.
		expect(
			screen.getAllByText(dayBadge("Due ", "2999-06-14T17:00:00")).length,
		).toBeGreaterThanOrEqual(1);
		expect(
			screen.getByText(dayBadge("Deferred to ", "2999-06-10T00:00:00")),
		).toBeInTheDocument();
		expect(screen.getByText("Daycare move")).toBeInTheDocument();
		// Linked person rendered with its waiting_on role label.
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(screen.getByText("Waiting on")).toBeInTheDocument();
	});

	it("shows the dropped date for a dropped todo", () => {
		const todo = todoItem("t_drop", {
			title: "Old vendor eval",
			status: "dropped",
			droppedAt: "2026-05-20T12:00:00",
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);
		expect(screen.getByText("Dropped")).toBeInTheDocument();
		expect(
			screen.getByText(dayBadge("Dropped ", "2026-05-20T12:00:00")),
		).toBeInTheDocument();
	});

	it("renders a recurrence summary badge for a recurring todo (ADR-0037)", () => {
		const todo = todoItem("t_rec", {
			title: "Weekly review",
			deferAt: "2026-06-14T09:00:00",
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
			},
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);
		expect(screen.getByText("Repeats weekly")).toBeInTheDocument();
	});

	it("renders no recurrence badge for a non-recurring todo (ADR-0037)", () => {
		const todo = todoItem("t_norec", { title: "One-off task" });
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);
		expect(screen.queryByText(/^Repeats/)).not.toBeInTheDocument();
	});
});

describe("EntityDetail Todo edit", () => {
	it("toggles to an edit form and saves a changed title as update_todo", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const todo = todoItem("t_edit", { title: "Old title" });
		renderDetail(
			<EntityDetail entity={todo} allEntities={[todo]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: todo.id });
			}),
		);

		await user.click(screen.getByRole("button", { name: /edit todo/i }));
		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "New title");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{
					mutation_kind: "update_todo",
					payload: { todo_id: todo.id, todo: { title: "New title" } },
				},
			]),
		);
		// Back to view mode: the editor's Save button is gone.
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /^save$/i }),
			).not.toBeInTheDocument(),
		);
	});
});

describe("EntityDetail Todo delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const todo = todoItem("t_del", { title: "Stale task" });
		renderDetail(
			<EntityDetail entity={todo} allEntities={[todo]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		// First click reveals the inline confirm, not a dialog.
		await user.click(screen.getByRole("button", { name: /delete todo/i }));
		expect(screen.getByText(/delete this todo\?/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{ mutation_kind: "delete_todo", payload: { entity_id: todo.id } },
			]),
		);
		await waitFor(() =>
			// Stays on the current route (the rail can be opened in-place from a
			// derived view) and only clears `?id`.
			expect(navigate).toHaveBeenCalledWith({
				to: ".",
				search: {},
			}),
		);
	});

	it("can cancel the delete confirm without writing", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const todo = todoItem("t_keep", { title: "Keep me" });
		renderDetail(
			<EntityDetail entity={todo} allEntities={[todo]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete todo/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(screen.queryByText(/delete this todo\?/i)).not.toBeInTheDocument();
		expect(seen).toHaveLength(0);
	});
});

describe("EntityDetail Person projection", () => {
	it("shows aliases, waiting tasks, and projects derived through todos", () => {
		const alice = person("p_alice", "Alice", { aliases: ["Allie", "A."] });
		const proj = project("pr_1", "Daycare move");
		const waitingTodo = todoItem("t_wait", {
			title: "Schedule from Alice",
			projectId: "pr_1",
			personRefs: [{ personId: "p_alice", role: "waiting_on" }],
		});
		const all: LibraryItem[] = [alice, proj, waitingTodo];

		renderDetail(<EntityDetail entity={alice} allEntities={all} />);

		expect(screen.getByText(/Allie, A\./)).toBeInTheDocument();
		// Waiting-on section lists the task; Projects derives pr_1 through the todo.
		expect(screen.getByText("Schedule from Alice")).toBeInTheDocument();
		expect(screen.getByText("Daycare move")).toBeInTheDocument();
	});

	it("keeps a resolved waiting_on todo out of 'Waiting on' (active only)", () => {
		const alice = person("p_alice", "Alice");
		const resolved = todoItem("t_done", {
			title: "Already got the draft",
			status: "completed",
			completedAt: "2026-06-01T12:00:00",
			personRefs: [{ personId: "p_alice", role: "waiting_on" }],
		});
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice, resolved]} />,
		);

		// The completed task is not a live follow-up — no "Waiting on" section.
		expect(screen.queryByText("Waiting on")).not.toBeInTheDocument();
		// It still appears as a (historical) task.
		expect(screen.getByText("Tasks")).toBeInTheDocument();
		expect(screen.getByText("Already got the draft")).toBeInTheDocument();
	});

	it("shows 'Mentioned in' journal entries that reference the person", () => {
		const alice = person("p_alice", "Alice");
		const journalEntry: JournalEntry = {
			id: "je_1",
			kind: "journal_entry",
			occurredAt: "2026-06-10T10:30:00",
			body: [
				{ type: "text", text: "Met " },
				{
					type: "entity_ref",
					refId: "ref_1",
					targetEntityId: "p_alice",
					targetKind: "person",
					targetTitle: "Alice",
				},
				{ type: "text", text: " about daycare." },
			],
			recency: 1,
			createdAt: "fixture",
		};
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice, journalEntry]} />,
		);

		expect(screen.getByText("Mentioned in")).toBeInTheDocument();
		// The referencing journal entry is listed as a related row.
		expect(screen.getByText("Met Alice about daycare.")).toBeInTheDocument();
	});
});

describe("EntityDetail Project projection", () => {
	it("shows note, review state, and people derived through its todos", () => {
		const alice = person("p_alice", "Alice");
		const proj = project("pr_1", "Daycare move", {
			note: "Provider switch by August.",
			nextReviewAt: "2026-06-21T20:00:00",
			lastReviewedAt: "2026-06-14T20:00:00",
		});
		const todo = todoItem("t_1", {
			projectId: "pr_1",
			personRefs: [{ personId: "p_alice", role: "related" }],
		});
		const all: LibraryItem[] = [alice, proj, todo];

		renderDetail(<EntityDetail entity={proj} allEntities={all} />);

		expect(screen.getByText("Provider switch by August.")).toBeInTheDocument();
		expect(
			screen.getByText(dayBadge("Next review ", "2026-06-21T20:00:00")),
		).toBeInTheDocument();
		expect(
			screen.getByText(dayBadge("last reviewed ", "2026-06-14T20:00:00")),
		).toBeInTheDocument();
		// Person derived through the project's todo appears (no direct link).
		expect(screen.getByText("Alice")).toBeInTheDocument();
	});
});

describe("EntityDetail Person delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const alice = person("p_del", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete person/i }));
		expect(screen.getByText(/delete this person\?/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{ mutation_kind: "delete_person", payload: { entity_id: alice.id } },
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: ".", search: {} }),
		);
	});

	it("can cancel the delete confirm without writing", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const alice = person("p_keep", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete person/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(screen.queryByText(/delete this person\?/i)).not.toBeInTheDocument();
		expect(seen).toHaveLength(0);
	});
});

describe("EntityDetail Project delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const proj = project("pr_del", "Daycare move");
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete project/i }));
		expect(screen.getByText(/delete this project\?/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{ mutation_kind: "delete_project", payload: { entity_id: proj.id } },
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				to: ".",
				search: {},
			}),
		);
	});

	it("can cancel the delete confirm without writing", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const proj = project("pr_keep", "Daycare move");
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete project/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(
			screen.queryByText(/delete this project\?/i),
		).not.toBeInTheDocument();
		expect(seen).toHaveLength(0);
	});
});

describe("EntityDetail Journal Entry delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const entry = journal([{ type: "text", text: "Stale note." }]);
		renderDetail(
			<EntityDetail entity={entry} allEntities={[entry]} />,
			makeRuntime((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		// First click reveals the inline confirm, not a dialog.
		await user.click(
			screen.getByRole("button", { name: /delete journal entry/i }),
		);
		expect(
			screen.getByText(/delete this journal entry\?/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{
					mutation_kind: "delete_journal_entry",
					payload: { entity_id: entry.id },
				},
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: ".", search: {} }),
		);
	});
});

// ── Captured-from provenance footer (ADR-0030) ───────────────────────────────

describe("EntityDetail Captured from", () => {
	it("links a Thread-sourced Entity back to its originating chat", async () => {
		const user = userEvent.setup();
		const todo = todoItem("t_msg", {
			title: "Buy milk",
			source: {
				kind: "thread",
				threadId: "thr_1",
				threadTitle: "Morning brain dump",
			},
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);

		await user.click(
			screen.getByRole("button", { name: /Morning brain dump/ }),
		);

		// The source-thread link navigates to that Thread's route (ADR-0042).
		expect(navigate).toHaveBeenCalledWith({
			to: "/thread/$threadId",
			params: { threadId: "thr_1" },
		});
	});

	it("links a Journal-Entry-sourced Entity to that entry in the Library", async () => {
		const user = userEvent.setup();
		const entry: JournalEntry = {
			id: "je_1",
			kind: "journal_entry",
			occurredAt: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Standup notes" }],
			createdAt: "fixture",
			recency: 1,
		};
		const todo = todoItem("t_je", {
			title: "Email Alice",
			source: { kind: "journal_entry", journalEntryId: "je_1" },
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo, entry]} />);

		// The chip title resolves from the loaded JE (libraryItemTitle of a
		// text-only entry is its body text).
		await user.click(screen.getByRole("button", { name: /Standup notes/ }));

		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "journal" },
			search: { id: "je_1" },
		});
		// A Journal-Entry source never routes to a Thread.
		expect(navigate).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: "/thread/$threadId" }),
		);
	});

	it("renders no footer for a user-authored Entity (no source)", () => {
		const todo = todoItem("t_user", {
			title: "Hand-made",
			createdAt: "Jun 14",
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);

		// A user-authored Entity has no provenance, so the footer is absent
		// entirely — no "Captured from" header, no origin line.
		expect(screen.queryByText(/Captured from/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Created in Library/)).not.toBeInTheDocument();
	});

	it("renders no footer when the source entry is gone (cascade-deleted)", () => {
		const todo = todoItem("t_orphan", {
			title: "Orphaned",
			source: { kind: "journal_entry", journalEntryId: "missing_je" },
		});
		// allEntities lacks `missing_je` → no resolvable target → no dead row.
		renderDetail(<EntityDetail entity={todo} allEntities={[todo]} />);

		expect(screen.queryByText(/Captured from/)).not.toBeInTheDocument();
	});

	it("falls back to a label when the source Journal Entry has empty body text", () => {
		// A text-only entry's title is its body text; an empty body would leave the
		// link with no accessible name, so the JE branch falls back like the Thread.
		const entry: JournalEntry = {
			id: "je_blank",
			kind: "journal_entry",
			occurredAt: "2026-06-10T10:30:00",
			body: [],
			createdAt: "fixture",
			recency: 1,
		};
		const todo = todoItem("t_blank_je", {
			title: "From a blank entry",
			source: { kind: "journal_entry", journalEntryId: "je_blank" },
		});
		renderDetail(<EntityDetail entity={todo} allEntities={[todo, entry]} />);

		expect(
			screen.getByRole("button", { name: /Untitled journal entry/ }),
		).toBeInTheDocument();
	});
});
