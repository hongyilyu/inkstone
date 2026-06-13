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
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	JournalEntry,
	LibraryItem,
	Person,
	Project,
	Todo,
} from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { EntityDetail } from "./EntityDetail";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

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
		threadGet: () => unused,
		listEntities: () => unused,
		entityMutate,
		subscribeRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
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
		expect(screen.getAllByText(/Due 2999-06-14/).length).toBeGreaterThanOrEqual(
			1,
		);
		expect(screen.getByText(/Deferred to 2999-06-10/)).toBeInTheDocument();
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
		expect(screen.getByText(/Dropped 2026-05-20/)).toBeInTheDocument();
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

		expect(seen).toEqual([
			{
				mutation_kind: "update_todo",
				payload: { todo_id: todo.id, todo: { title: "New title" } },
			},
		]);
		// Back to view mode: the editor's Save button is gone.
		expect(
			screen.queryByRole("button", { name: /^save$/i }),
		).not.toBeInTheDocument();
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

		expect(seen).toEqual([
			{ mutation_kind: "delete_todo", payload: { entity_id: todo.id } },
		]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "todos" },
			search: {},
		});
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
		expect(screen.getByText(/Next review 2026-06-21/)).toBeInTheDocument();
		expect(screen.getByText(/last reviewed 2026-06-14/)).toBeInTheDocument();
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

		expect(seen).toEqual([
			{ mutation_kind: "delete_person", payload: { entity_id: alice.id } },
		]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "people" },
			search: {},
		});
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

		expect(seen).toEqual([
			{ mutation_kind: "delete_project", payload: { entity_id: proj.id } },
		]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "projects" },
			search: {},
		});
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

		expect(seen).toEqual([
			{
				mutation_kind: "delete_journal_entry",
				payload: { entity_id: entry.id },
			},
		]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "journal" },
			search: {},
		});
	});
});
