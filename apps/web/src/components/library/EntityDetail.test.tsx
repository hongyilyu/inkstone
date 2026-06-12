import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	JournalEntry,
	LibraryItem,
	Person,
	Project,
	Todo,
} from "@/lib/libraryItems";
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
		render(
			<EntityDetail
				entity={journal([{ type: "text", text: "Bought milk." }])}
				allEntities={[]}
			/>,
		);

		expect(screen.getAllByText("Bought milk.")).toHaveLength(2);
	});

	it("renders mixed text and inline ref chips in order", () => {
		render(
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
		render(
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
		render(
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

		render(<EntityDetail entity={todo} allEntities={all} />);

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
		render(<EntityDetail entity={todo} allEntities={[todo]} />);
		expect(screen.getByText("Dropped")).toBeInTheDocument();
		expect(screen.getByText(/Dropped 2026-05-20/)).toBeInTheDocument();
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

		render(<EntityDetail entity={alice} allEntities={all} />);

		expect(screen.getByText(/Allie, A\./)).toBeInTheDocument();
		// Waiting-on section lists the task; Projects derives pr_1 through the todo.
		expect(screen.getByText("Schedule from Alice")).toBeInTheDocument();
		expect(screen.getByText("Daycare move")).toBeInTheDocument();
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

		render(<EntityDetail entity={proj} allEntities={all} />);

		expect(screen.getByText("Provider switch by August.")).toBeInTheDocument();
		expect(screen.getByText(/Next review 2026-06-21/)).toBeInTheDocument();
		expect(screen.getByText(/last reviewed 2026-06-14/)).toBeInTheDocument();
		// Person derived through the project's todo appears (no direct link).
		expect(screen.getByText("Alice")).toBeInTheDocument();
	});
});
