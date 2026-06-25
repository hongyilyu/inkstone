import type {
	EntityListResult,
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Todo } from "@/lib/libraryItems";
import { people, todos } from "@/lib/libraryItems.fixtures";
import { RuntimeProvider } from "@/runtime";
import { EntityRow, TodoRow } from "./EntityRow";

const todo = (id: string) => {
	const t = todos.find((x) => x.id === id);
	if (!t) throw new Error(`missing todo ${id}`);
	return t;
};
const person = (id: string) => {
	const p = people.find((x) => x.id === id);
	if (!p) throw new Error(`missing person ${id}`);
	return p;
};

type EntityMutate = (
	params: EntityMutateParams,
) => Effect.Effect<EntityMutateResult, WsError>;
type Rows = EntityListResult["entities"];

// Inline-complete needs the mutation harness (TodoRow runs `useEntityMutation`
// per-row). Mirror ProjectReviewView.test.tsx's stub — every WsClient method
// must be present or the type fails; only `entityMutate` is exercised here.
function renderTodoRow(
	node: ReactNode,
	entityMutate: EntityMutate = () => Effect.die("entityMutate not exercised"),
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: () => Effect.succeed({ entities: [] as Rows }),
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
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
	});
	const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	return render(<ul>{node}</ul>, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
			</QueryClientProvider>
		),
	});
}

afterEach(cleanup);

describe("TodoRow", () => {
	it("shows status read-only — no done toggle (editing is deferred)", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		// The old "Mark done" toggle is gone; an active todo carries an Active mark.
		expect(
			screen.queryByRole("button", { name: /mark .* done/i }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("Active")).toBeInTheDocument();
	});

	it("marks a completed todo without offering a toggle", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_cutover")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByLabelText("Completed")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /mark/i }),
		).not.toBeInTheDocument();
	});

	it("marks a dropped todo with its own glyph", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_old_vendor")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByLabelText("Dropped")).toBeInTheDocument();
	});

	it("opens detail when the row is clicked", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={onSelect} />
			</ul>,
		);

		await user.click(
			screen.getByRole("button", { name: /^Send Alice the updated/i }),
		);

		expect(onSelect).toHaveBeenCalledWith("todo_schedule_alice");
	});

	it("flags an overdue active todo with a label, not colour alone", () => {
		// Force a due date far in the past so the assertion is clock-proof.
		const overdue: Todo = {
			...todo("todo_dentist"),
			dueAt: "2000-01-01T09:00:00",
		};
		render(
			<ul>
				<TodoRow todo={overdue} onSelect={() => {}} />
			</ul>,
		);
		// Overdue keeps the date so multiple overdue rows stay distinguishable.
		expect(screen.getByText("Overdue · 2000-01-01")).toBeInTheDocument();
	});

	it("shows the due date when not overdue", () => {
		const future: Todo = {
			...todo("todo_schedule_alice"),
			dueAt: "2999-01-02T17:00:00",
		};
		render(
			<ul>
				<TodoRow todo={future} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("2999-01-02")).toBeInTheDocument();
		expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
	});

	it("shows an Available <date> chip when the todo is deferred", () => {
		// Far-future defer date so the chip is clock-proof.
		const deferred: Todo = {
			...todo("todo_schedule_alice"),
			deferAt: "2999-01-05T00:00:00",
		};
		render(
			<ul>
				<TodoRow todo={deferred} onSelect={() => {}} />
			</ul>,
		);
		// Chip shows the YYYY-MM-DD day slice, matching DueChip's format.
		expect(screen.getByText("Available 2999-01-05")).toBeInTheDocument();
	});

	it("shows no Available chip when the todo is not deferred", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.queryByText(/^Available /)).not.toBeInTheDocument();
	});

	it("shows both the due date and the Available chip when the todo has both", () => {
		const both: Todo = {
			...todo("todo_schedule_alice"),
			deferAt: "2999-01-05T00:00:00",
			dueAt: "2999-01-09T17:00:00",
		};
		render(
			<ul>
				<TodoRow todo={both} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("2999-01-09")).toBeInTheDocument();
		expect(screen.getByText("Available 2999-01-05")).toBeInTheDocument();
	});

	// (c) Read-only pin: with NO `onComplete`, an active row exposes no complete
	// button — the default contract stays read-only (the older assertions above
	// pin the same default; this one keys off the new aria-label string).
	it("exposes no complete button when onComplete is absent", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		expect(
			screen.queryByRole("button", { name: /mark todo complete/i }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("Active")).toBeInTheDocument();
	});

	// (a) With `onComplete` on an active row, the status circle becomes a
	// "Mark todo complete" button; clicking it fires one `update_todo` mutate
	// carrying status=completed and a non-empty completed_at.
	it("completes an active todo inline via its status circle (update_todo)", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "todo_schedule_alice" }),
		);
		renderTodoRow(
			<TodoRow
				todo={todo("todo_schedule_alice")}
				onSelect={() => {}}
				onComplete={() => {}}
			/>,
			entityMutate,
		);

		await userEvent.click(
			screen.getByRole("button", { name: /mark todo complete/i }),
		);

		await waitFor(() => expect(entityMutate).toHaveBeenCalledTimes(1));
		const call = entityMutate.mock.calls[0]?.[0] as EntityMutateParams;
		expect(call.mutation_kind).toBe("update_todo");
		const payload = call.payload as {
			todo_id: string;
			todo: { status: string; completed_at: string };
		};
		expect(payload.todo_id).toBeTruthy();
		expect(payload.todo.status).toBe("completed");
		expect(payload.todo.completed_at).toBeTruthy();
	});

	// (b) Optimistic flip: the mock leaves the stored status `active` but
	// succeeds, so only the `mutation.isSuccess` seam can flip the accessible
	// name to "Completed". Dropping `|| mutation.isSuccess` fails this.
	it("optimistically flips the circle to Completed after a successful click", async () => {
		renderTodoRow(
			<TodoRow
				todo={todo("todo_schedule_alice")}
				onSelect={() => {}}
				onComplete={() => {}}
			/>,
			() => Effect.succeed({ entity_id: "todo_schedule_alice" }),
		);

		await userEvent.click(
			screen.getByRole("button", { name: /mark todo complete/i }),
		);

		expect(
			await screen.findByRole("button", { name: /^completed$/i }),
		).toBeInTheDocument();
	});

	// (d) Active-gate: a resolved row (completed/dropped) rendered WITH
	// `onComplete` is still read-only — only active rows get the interactive
	// circle.
	it("stays read-only for a completed todo even with onComplete", () => {
		renderTodoRow(
			<TodoRow
				todo={todo("todo_cutover")}
				onSelect={() => {}}
				onComplete={() => {}}
			/>,
		);
		expect(screen.getByLabelText("Completed")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /mark todo complete/i }),
		).not.toBeInTheDocument();
	});

	it("stays read-only for a dropped todo even with onComplete", () => {
		renderTodoRow(
			<TodoRow
				todo={todo("todo_old_vendor")}
				onSelect={() => {}}
				onComplete={() => {}}
			/>,
		);
		expect(screen.getByLabelText("Dropped")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /mark todo complete/i }),
		).not.toBeInTheDocument();
	});
});

describe("EntityRow", () => {
	it("renders title + subtitle and reports selection", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<EntityRow entity={person("person_priya")} onSelect={onSelect} />);

		expect(screen.getByText("Priya Nair")).toBeInTheDocument();
		expect(screen.getByText(/Owns the SDK examples/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /priya nair/i }));
		expect(onSelect).toHaveBeenCalledWith("person_priya");
	});
});
