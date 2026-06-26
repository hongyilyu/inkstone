import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem, Person, Project, Todo } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { TodoEditor } from "./TodoEditor";

// Stub WsClient whose `entityMutate` records params and succeeds; `recurrencePreview`
// runs the supplied handler (defaults to dying); other methods die.
function makeRuntime(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError>,
	recurrencePreview: WsClient["Type"]["recurrencePreview"] = () =>
		Effect.die("not exercised in this test"),
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		recurrencePreview,
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
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderEditor(
	props: Parameters<typeof TodoEditor>[0],
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
	recurrencePreview?: WsClient["Type"]["recurrencePreview"],
) {
	const runtime = makeRuntime(entityMutate, recurrencePreview);
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
	return render(<TodoEditor {...props} />, { wrapper: Wrapper });
}

const alice: Person = {
	id: "01900000-0000-7000-8000-0000000000a1",
	kind: "person",
	name: "Alice",
	recency: 1,
	createdAt: "fixture",
};

const project: Project = {
	id: "01900000-0000-7000-8000-0000000000b1",
	kind: "project",
	name: "Daycare move",
	status: "active",
	recency: 1,
	createdAt: "fixture",
};

const existing: Todo = {
	id: "01900000-0000-7000-8000-0000000000c1",
	kind: "todo",
	title: "Send schedule",
	status: "active",
	personRefs: [],
	recency: 1,
	createdAt: "fixture",
};

const allEntities: LibraryItem[] = [alice, project, existing];

afterEach(cleanup);

// Deterministic flush for the negative preview assertions: drain pending
// microtasks (react-query schedules its queryFn on the microtask queue, never a
// timer), so "no read fired" is proven without a wall-clock sleep. A disabled
// query never schedules at all; this just gives any erroneous schedule a turn.
const flushMicrotasks = async () => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("TodoEditor Save gate", () => {
	// The compound guard surfaces to the frame: an empty title leaves Save disabled.
	it("disables Save while the title is empty and enables it once filled", async () => {
		const user = userEvent.setup();
		renderEditor({
			mode: "create",
			allEntities,
			onDone: () => {},
			onCancel: () => {},
		});

		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeDisabled();

		await user.type(screen.getByLabelText(/title/i), "Send schedule");
		expect(save).toBeEnabled();
	});

	// Beyond the single-field case: even with a title, an invalid recurrence rule
	// (Repeats on, no anchor date) keeps Save disabled until the date is set.
	it("disables Save when Repeats is on but the anchor date is missing", async () => {
		const user = userEvent.setup();
		renderEditor({
			mode: "create",
			allEntities,
			onDone: () => {},
			onCancel: () => {},
		});

		await user.type(screen.getByLabelText(/title/i), "Send schedule");
		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeEnabled();

		await user.click(screen.getByLabelText(/repeats/i));
		// Repeats defaults the anchor to defer (no due date set), whose date is absent.
		expect(save).toBeDisabled();

		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		expect(save).toBeEnabled();
	});
});

describe("TodoEditor create", () => {
	it("emits create_todo with only the filled fields", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "create", allEntities, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Buy milk");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_todo",
			payload: { todo: { title: "Buy milk" } },
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("includes a project link and a person ref when chosen", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Get the schedule");
		await user.selectOptions(screen.getByLabelText(/project/i), project.id);
		// Add a person row, then flip its default `related` role to waiting_on.
		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.selectOptions(screen.getByLabelText(/^person$/i), alice.id);
		await user.selectOptions(screen.getByLabelText(/^role$/i), "waiting_on");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Get the schedule", project_id: project.id },
				person_refs: [{ person_id: alice.id, role: "waiting_on" }],
			},
		});
	});

	it("adds a person row defaulting to the related role", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Loop Alice in");
		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.selectOptions(screen.getByLabelText(/^person$/i), alice.id);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Loop Alice in" },
				person_refs: [{ person_id: alice.id, role: "related" }],
			},
		});
	});
});

describe("TodoEditor edit", () => {
	it("emits update_todo with only the changed title", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", todo: existing, allEntities, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "Send the new schedule");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: existing.id,
				todo: { title: "Send the new schedule" },
			},
		});
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
	});

	it("emits set_person_refs when linking a new person", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: existing,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.selectOptions(screen.getByLabelText(/^person$/i), alice.id);
		await user.selectOptions(screen.getByLabelText(/^role$/i), "waiting_on");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: existing.id,
				set_person_refs: [{ person_id: alice.id, role: "waiting_on" }],
			},
		});
	});

	it("does nothing when no field changed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", todo: existing, allEntities, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
		expect(seen).toHaveLength(0);
	});

	// A status change must clear the now-invalid timestamp(s) via sentinel-null, or
	// Core's re-validation of the merged whole rejects the stale `completed_at`/
	// `dropped_at` left on the stored Todo (ADR-0033).
	it("clears completed_at and dropped_at when leaving a terminal status", async () => {
		const completed: Todo = {
			...existing,
			status: "completed",
			completedAt: "2026-06-01T09:00:00",
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: completed,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: completed.id });
			},
		);

		await user.selectOptions(screen.getByLabelText(/status/i), "active");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: completed.id,
				todo: { status: "active", completed_at: null, dropped_at: null },
			},
		});
	});

	it("clears dropped_at and sets completed_at on active→completed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: existing,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.selectOptions(screen.getByLabelText(/status/i), "completed");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const partial = (seen[0].payload as { todo: Record<string, unknown> }).todo;
		expect(partial.status).toBe("completed");
		expect(partial.dropped_at).toBeNull();
		expect(typeof partial.completed_at).toBe("string");
	});

	// Clearing an optional must send sentinel-null (clear directive), not omit the
	// key (which would preserve the stored value — ADR-0033).
	it("sends due_at:null when an existing due date is cleared", async () => {
		const withDue: Todo = { ...existing, dueAt: "2026-06-20T00:00:00" };
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: withDue,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withDue.id });
			},
		);

		await user.clear(screen.getByLabelText(/due/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: withDue.id, todo: { due_at: null } },
		});
	});

	const bob: Person = {
		id: "01900000-0000-7000-8000-0000000000a2",
		kind: "person",
		name: "Bob",
		recency: 1,
		createdAt: "fixture",
	};

	// Rebuilding the ref set must map ALL kept refs to snake_case `person_id`; a
	// leaked camelCase `personId` is rejected by Core's validate_person_ref. Adding
	// a second person preserves the first row's ref and snake_cases the whole set.
	it("preserves other refs as snake_case when adding a person", async () => {
		const withRelated: Todo = {
			...existing,
			personRefs: [{ personId: bob.id, role: "related" }],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: withRelated,
				allEntities: [...allEntities, bob],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withRelated.id });
			},
		);

		// Bob's existing row is index 0; add a second row for Alice as waiting_on.
		await user.click(screen.getByRole("button", { name: /add person/i }));
		const personSelects = screen.getAllByLabelText(/^person$/i);
		await user.selectOptions(personSelects[1], alice.id);
		const roleSelects = screen.getAllByLabelText(/^role$/i);
		await user.selectOptions(roleSelects[1], "waiting_on");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const refs = (seen[0].payload as { set_person_refs: unknown[] })
			.set_person_refs;
		expect(refs).toEqual([
			{ person_id: bob.id, role: "related" },
			{ person_id: alice.id, role: "waiting_on" },
		]);
	});

	it("carries the new role when an existing row's role changes", async () => {
		const withRelated: Todo = {
			...existing,
			personRefs: [{ personId: alice.id, role: "related" }],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: withRelated,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withRelated.id });
			},
		);

		await user.selectOptions(screen.getByLabelText(/^role$/i), "waiting_on");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(
			(seen[0].payload as { set_person_refs: unknown[] }).set_person_refs,
		).toEqual([{ person_id: alice.id, role: "waiting_on" }]);
	});

	it("drops a removed person's row from the emitted set", async () => {
		const withTwo: Todo = {
			...existing,
			personRefs: [
				{ personId: alice.id, role: "waiting_on" },
				{ personId: bob.id, role: "related" },
			],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: withTwo,
				allEntities: [...allEntities, bob],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withTwo.id });
			},
		);

		// Remove the first row (Alice).
		const removes = screen.getAllByRole("button", { name: /remove person/i });
		await user.click(removes[0]);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const refs = (seen[0].payload as { set_person_refs: unknown[] })
			.set_person_refs;
		expect(refs).toEqual([{ person_id: bob.id, role: "related" }]);
		expect(JSON.stringify(refs)).not.toContain(alice.id);
	});

	// At-most-once per person is enforced structurally: a person chosen in one row
	// is not offered by any OTHER row's picker (its own row keeps it selectable).
	it("does not offer an already-chosen person in another row's picker", async () => {
		const user = userEvent.setup();
		renderEditor({
			mode: "edit",
			todo: existing,
			allEntities: [...allEntities, bob],
			onDone: () => {},
			onCancel: () => {},
		});

		// Row 0 → Alice.
		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.selectOptions(screen.getByLabelText(/^person$/i), alice.id);

		// Row 1's person picker must omit Alice (still offers Bob).
		await user.click(screen.getByRole("button", { name: /add person/i }));
		const personSelects = screen.getAllByLabelText(/^person$/i);
		const row1Options = Array.from(
			personSelects[1].querySelectorAll("option"),
		).map((o) => (o as HTMLOptionElement).value);
		expect(row1Options).not.toContain(alice.id);
		expect(row1Options).toContain(bob.id);
		// Row 0 still offers its own selection.
		const row0Options = Array.from(
			personSelects[0].querySelectorAll("option"),
		).map((o) => (o as HTMLOptionElement).value);
		expect(row0Options).toContain(alice.id);
	});

	// A blank (added-but-no-person-chosen) row must NOT reach the wire — the codec
	// pass-through trusts the editor to filter it, so Core never sees person_id:""
	// (which it rejects). This pins the submit-time filter that upholds that contract.
	it("omits a blank person row, emitting only the chosen ref", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: existing,
				allEntities: [...allEntities, bob],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		// Row 0 → Alice; row 1 added but left on "Choose a person" (blank).
		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.selectOptions(screen.getByLabelText(/^person$/i), alice.id);
		await user.click(screen.getByRole("button", { name: /add person/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const refs = (seen[0].payload as { set_person_refs: unknown[] })
			.set_person_refs;
		// Only Alice (a new row defaults to `related`) — the blank row is filtered,
		// so no `person_id: ""` reaches Core.
		expect(refs).toEqual([{ person_id: alice.id, role: "related" }]);
		expect(JSON.stringify(refs)).not.toContain('"person_id":""');
	});
});

describe("TodoEditor recurrence", () => {
	// Turning Repeats on with a defer date present emits the snake_case rule on
	// create (the editor defaults the anchor to defer_at when no due date — ADR-0037).
	it("emits a snake_case recurrence on create when Repeats is on", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Water the plants");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: {
					title: "Water the plants",
					defer_at: "2026-07-01T00:00:00",
					recurrence: {
						interval: 1,
						unit: "week",
						anchor: "defer_at",
					},
				},
			},
		});
	});

	// End condition (#227): choosing "On date" reveals the date field and folds
	// {until} into the rule the editor sends.
	it("emits an `until` end condition when End is set to a date", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Weekly standup");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^end$/i), "until");
		await user.type(screen.getByLabelText(/end date/i), "2026-12-31");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const todo = (seen[0].payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { until: "2026-12-31T00:00:00" },
		});
	});

	// End="After" with no count yet keeps Save disabled (the count guard), then
	// enables once a positive integer is entered and folds {after_count}.
	it("gates Save on the After count, then emits after_count", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Take pills");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^end$/i), "after");
		// The After count starts empty → Save is blocked.
		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeDisabled();
		await user.type(screen.getByLabelText(/^times$/i), "10");
		await waitFor(() => expect(save).toBeEnabled());
		await user.click(save);

		await waitFor(() => expect(seen).toHaveLength(1));
		const todo = (seen[0].payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { after_count: 10 },
		});
	});

	// Repeats off must omit `recurrence` entirely on create (never explicit null —
	// Core rejects null on create, ADR-0031/slice-3).
	it("omits recurrence on create when Repeats is off", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "One-off task");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const todo = (seen[0].payload as { todo: Record<string, unknown> }).todo;
		expect(todo).not.toHaveProperty("recurrence");
	});

	const recurringTodo: Todo = {
		...existing,
		deferAt: "2026-07-01T00:00:00",
		recurrence: {
			interval: 1,
			unit: "week",
			anchor: "defer_at",
		},
	};

	// Recurrence diffs as a whole object: changing the interval emits the entire
	// new rule, not a field-level partial.
	it("emits the whole rule when the interval changes on edit", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: recurringTodo,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: recurringTodo.id });
			},
		);

		const interval = screen.getByLabelText(/every/i);
		await user.clear(interval);
		await user.type(interval, "2");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: recurringTodo.id,
				todo: {
					recurrence: {
						interval: 2,
						unit: "week",
						anchor: "defer_at",
					},
				},
			},
		});
	});

	// Toggling Repeats off on an existing recurring Todo clears the rule via
	// sentinel-null (ADR-0033/0037), not by omitting the key.
	it("emits recurrence:null when Repeats is toggled off", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: recurringTodo,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: recurringTodo.id });
			},
		);

		await user.click(screen.getByLabelText(/repeats/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: recurringTodo.id, todo: { recurrence: null } },
		});
	});

	// Editing only the title on a recurring Todo must NOT emit a recurrence key
	// (deep-compare equal → unchanged).
	it("omits the recurrence key when the rule is unchanged", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: recurringTodo,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: recurringTodo.id });
			},
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "Send schedule v2");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const todo = (seen[0].payload as { todo: Record<string, unknown> }).todo;
		expect(todo).toEqual({ title: "Send schedule v2" });
		expect(todo).not.toHaveProperty("recurrence");
	});

	// Round-trip (ADR-0037/0039): the unsurfaced `end` condition must survive a
	// common-path edit untouched. Recurrence is replaced whole, so a stash that
	// drops it silently loses it.
	it("round-trips the end condition through a common-path edit", async () => {
		const fullyLoaded: Todo = {
			...existing,
			deferAt: "2026-07-01T00:00:00",
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
				end: { afterCount: 10 },
			},
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: fullyLoaded,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: fullyLoaded.id });
			},
		);

		const interval = screen.getByLabelText(/every/i);
		await user.clear(interval);
		await user.type(interval, "3");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: fullyLoaded.id,
				todo: {
					recurrence: {
						interval: 3,
						unit: "week",
						anchor: "defer_at",
						end: { after_count: 10 },
					},
				},
			},
		});
	});

	// Setting interval to "" (or "0") with Repeats on blocks Save: Core requires a
	// positive integer, so the editor gates rather than emitting an invalid rule.
	it("blocks save when the interval is empty while Repeats is on", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				todo: recurringTodo,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: recurringTodo.id });
			},
		);

		const interval = screen.getByLabelText(/every/i);
		await user.clear(interval);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// Give any (erroneous) mutation a chance to fire, then assert none did.
		await new Promise((r) => setTimeout(r, 50));
		expect(seen).toHaveLength(0);

		// A valid interval unblocks the save.
		await user.type(interval, "2");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(
			(seen[0].payload as { todo: Record<string, unknown> }).todo.recurrence,
		).toEqual({
			interval: 2,
			unit: "week",
			anchor: "defer_at",
		});
	});

	// ADVISORY fix: Repeats on but the anchor's date absent must block Save (Core
	// rejects an anchorless rule). Setting the date then lets the save proceed.
	it("blocks save while Repeats is on but the anchor date is absent", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Repeat me");
		await user.click(screen.getByLabelText(/repeats/i));
		// No defer/due date set: the anchor date is missing.
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// Give any (erroneous) mutation a chance to fire, then assert none did.
		await new Promise((r) => setTimeout(r, 50));
		expect(seen).toHaveLength(0);

		// Setting the anchor's date unblocks the save and emits the rule.
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(
			(seen[0].payload as { todo: Record<string, unknown> }).todo.recurrence,
		).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
		});
	});
});

// Next-occurrence preview (#227): a bounded series (End != Never) reads
// recurrence/preview and renders Core's computed dates, the terminal copy when
// the series ends, and nothing when End = Never.
describe("TodoEditor next-occurrence preview", () => {
	const noMutate = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" });

	it("shows the next occurrence's dates for a bounded series", async () => {
		const user = userEvent.setup();
		const seen: unknown[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			noMutate,
			() => {
				seen.push("called");
				return Effect.succeed({
					ended: false,
					defer_at: "2026-07-08T00:00:00",
					due_at: undefined,
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Weekly standup");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^end$/i), "after");
		await user.type(screen.getByLabelText(/^times$/i), "10");

		// The preview block names itself and renders the resolved defer date.
		expect(await screen.findByText(/dates for next occurrence/i)).toBeTruthy();
		await waitFor(() => expect(screen.getByText(/defer .*2026/i)).toBeTruthy());
		expect(seen.length).toBeGreaterThan(0);
	});

	it("names the last occurrence when the series has ended", async () => {
		const user = userEvent.setup();
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			noMutate,
			() => Effect.succeed({ ended: true }),
		);

		await user.type(screen.getByLabelText(/title/i), "Final repeat");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^end$/i), "after");
		await user.type(screen.getByLabelText(/^times$/i), "1");

		expect(await screen.findByText(/this is the last one/i)).toBeTruthy();
	});

	it("renders no preview block while End is Never (unbounded series)", async () => {
		const user = userEvent.setup();
		const seen: unknown[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			noMutate,
			() => {
				seen.push("called");
				return Effect.succeed({ ended: false });
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Forever task");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		// End defaults to Never: no preview, and the read never fires.
		expect(screen.queryByText(/dates for next occurrence/i)).toBeNull();
		expect(screen.queryByText(/this is the last one/i)).toBeNull();
		// No read should ever fire (query disabled); prove it deterministically.
		await flushMicrotasks();
		expect(seen).toHaveLength(0);
	});

	// End chosen but its value not yet entered (After with a blank count): the
	// preview must NOT fire — otherwise it would show a "next occurrence" for the
	// unbounded rule buildRecurrence emits mid-entry (#227 review-fix gate).
	it("does not fire the preview while the End value is incomplete", async () => {
		const user = userEvent.setup();
		const seen: unknown[] = [];
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			noMutate,
			() => {
				seen.push("called");
				return Effect.succeed({ ended: false });
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Half-entered");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^end$/i), "after");
		// Count left blank → incomplete end → no preview, no read.
		expect(screen.queryByText(/dates for next occurrence/i)).toBeNull();
		await flushMicrotasks();
		expect(seen).toHaveLength(0);
	});

	// A sub-day cadence (hour/minute) advances by a time span, so the preview must
	// render WITH the time — date-only would print the same date for two
	// consecutive occurrences (#227 review-fix: formatNextDate).
	it("renders the next occurrence WITH a time for an hourly cadence", async () => {
		const user = userEvent.setup();
		renderEditor(
			{ mode: "create", allEntities, onDone: () => {}, onCancel: () => {} },
			noMutate,
			() =>
				Effect.succeed({
					ended: false,
					defer_at: "2026-07-01T13:00:00",
					due_at: undefined,
				}),
		);

		await user.type(screen.getByLabelText(/title/i), "Hourly ping");
		await user.type(screen.getByLabelText(/defer until/i), "2026-07-01");
		await user.click(screen.getByLabelText(/repeats/i));
		await user.selectOptions(screen.getByLabelText(/^unit$/i), "hour");
		await user.selectOptions(screen.getByLabelText(/^end$/i), "after");
		await user.type(screen.getByLabelText(/^times$/i), "5");

		// The preview renders the successor WITH a time component (e.g. "1:00 PM"),
		// which the date-only formatter would have dropped. Scope to the preview
		// block (the heading's container) to avoid the "Defer until" field label.
		const heading = await screen.findByText(/dates for next occurrence/i);
		const previewBlock = heading.parentElement as HTMLElement;
		expect(previewBlock.textContent).toMatch(/Defer .*\d{1,2}:\d{2}/);
	});
	// The stale-data-on-error guard is pinned at the hook level
	// (useRecurrenceNextDates.test.tsx) where the success-then-refetch-failure
	// path is reproducible; a cold component failure has no retained data to test.
});
