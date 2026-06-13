import type {
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
import type { LibraryItem, Person, Project, Todo } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { TodoEditor } from "./TodoEditor";

// Stub WsClient whose `entityMutate` records params and succeeds; unused methods die.
function makeRuntime(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError>,
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

function renderEditor(
	props: Parameters<typeof TodoEditor>[0],
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
) {
	const runtime = makeRuntime(entityMutate);
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
		await user.selectOptions(screen.getByLabelText(/waiting on/i), alice.id);
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

	it("emits a person-ref add op when linking a new person", async () => {
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

		await user.selectOptions(screen.getByLabelText(/waiting on/i), alice.id);
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

	// Rebuilding the ref set must map ALL kept refs to snake_case `person_id`; a
	// leaked camelCase `personId` is rejected by Core's validate_person_ref.
	it("preserves other refs as snake_case when changing the waiting_on link", async () => {
		const bob: Person = {
			id: "01900000-0000-7000-8000-0000000000a2",
			kind: "person",
			name: "Bob",
			recency: 1,
			createdAt: "fixture",
		};
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

		await user.selectOptions(screen.getByLabelText(/waiting on/i), alice.id);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const refs = (seen[0].payload as { set_person_refs: unknown[] })
			.set_person_refs;
		expect(refs).toEqual([
			{ person_id: bob.id, role: "related" },
			{ person_id: alice.id, role: "waiting_on" },
		]);
	});
});
