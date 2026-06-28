import type {
	EntityListResult,
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { InvalidParamsError, WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { ProjectReviewView } from "./ProjectReviewView";

type Rows = EntityListResult["entities"];

type EntityMutate = (
	params: EntityMutateParams,
) => Effect.Effect<EntityMutateResult, WsError>;

function makeRuntime(
	projects: Rows,
	todos: Rows,
	people: Rows,
	entityMutate: EntityMutate,
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: (type) => {
			if (type === "project") return Effect.succeed({ entities: projects });
			if (type === "todo") return Effect.succeed({ entities: todos });
			if (type === "person") return Effect.succeed({ entities: people });
			return Effect.succeed({ entities: [] });
		},
		getBacklinks: () => unused,
		observationQuery: () => unused,
		entityMutate,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
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

function renderReview(
	projects: Rows,
	todos: Rows = [],
	people: Rows = [],
	entityMutate: EntityMutate = () => Effect.die("entityMutate not exercised"),
	onSelect: (id: string) => void = () => {},
) {
	const runtime = makeRuntime(projects, todos, people, entityMutate);
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
	return render(<ProjectReviewView selectedId={null} onSelect={onSelect} />, {
		wrapper: Wrapper,
	});
}

const project = (
	id: string,
	name: string,
	data: Record<string, unknown>,
): Rows[number] => ({
	id,
	type: "project",
	data: { name, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

const todo = (
	id: string,
	title: string,
	data: Record<string, unknown>,
): Rows[number] => ({
	id,
	type: "todo",
	data: { title, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

// Past = unambiguously due regardless of real "now"; far future = never due.
const PAST = "2000-01-01T20:00:00";
const FUTURE = "2999-01-01T20:00:00";

afterEach(cleanup);

describe("ProjectReviewView (focused queue)", () => {
	it("focuses one due project with a position counter, excludes future/terminal", async () => {
		renderReview([
			project("p_active", "Active due", { next_review_at: PAST }),
			project("p_hold", "On hold due", {
				status: "on_hold",
				next_review_at: PAST,
			}),
			project("p_future", "Not yet due", { next_review_at: FUTURE }),
			project("p_done", "Completed", {
				status: "completed",
				completed_at: PAST,
				next_review_at: PAST,
			}),
		]);

		// Only the first due project is focused; the counter reflects the 2 due.
		expect(await screen.findByText("Active due")).toBeInTheDocument();
		expect(screen.getByText("Project 1 of 2")).toBeInTheDocument();
		expect(screen.queryByText("On hold due")).not.toBeInTheDocument();
		expect(screen.queryByText("Not yet due")).not.toBeInTheDocument();
		expect(screen.queryByText("Completed")).not.toBeInTheDocument();
	});

	it("steps between projects with the up/down chevrons", async () => {
		// Two due projects, ordered by next_review_at (soonest first).
		renderReview([
			project("p1", "First project", { next_review_at: "2000-01-01T20:00:00" }),
			project("p2", "Second project", {
				next_review_at: "2000-01-02T20:00:00",
			}),
		]);

		expect(await screen.findByText("First project")).toBeInTheDocument();
		expect(screen.getByText("Project 1 of 2")).toBeInTheDocument();
		// At the first project, "previous" is disabled.
		expect(
			screen.getByRole("button", { name: /previous project/i }),
		).toBeDisabled();

		await userEvent.click(
			screen.getByRole("button", { name: /next project/i }),
		);
		expect(await screen.findByText("Second project")).toBeInTheDocument();
		expect(screen.getByText("Project 2 of 2")).toBeInTheDocument();
		// At the last project, "next" is disabled.
		expect(
			screen.getByRole("button", { name: /next project/i }),
		).toBeDisabled();

		// Step back up.
		await userEvent.click(
			screen.getByRole("button", { name: /previous project/i }),
		);
		expect(await screen.findByText("First project")).toBeInTheDocument();
	});

	it("renders the cadence label, last-reviewed, and the project's active todos", async () => {
		renderReview(
			[
				project("p1", "API migration", {
					next_review_at: PAST,
					last_reviewed_at: "2026-06-01T20:00:00",
					review_every: { interval: 1, unit: "week" },
				}),
			],
			[
				todo("t1", "Cut over traffic", { project_id: "p1" }),
				todo("t2", "Old done task", {
					status: "completed",
					completed_at: PAST,
					project_id: "p1",
				}),
			],
		);

		expect(await screen.findByText("API migration")).toBeInTheDocument();
		expect(screen.getByText("Every week")).toBeInTheDocument();
		expect(screen.getByText(/Last reviewed 2026-06-01/)).toBeInTheDocument();
		// Active todo shows; a long-completed one does not (only session-completed stay).
		expect(screen.getByText("Cut over traffic")).toBeInTheDocument();
		expect(screen.queryByText("Old done task")).not.toBeInTheDocument();
	});

	it("teaches the empty state when nothing is due", async () => {
		renderReview([project("p_future", "Later", { next_review_at: FUTURE })]);
		expect(await screen.findByText("All caught up")).toBeInTheDocument();
	});

	it("marks the focused project reviewed with an entity_id-only mutation (ADR-0034)", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "p1" }),
		);
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[],
			[],
			entityMutate,
		);

		await screen.findByText("API migration");
		await userEvent.click(
			screen.getByRole("button", { name: /mark reviewed/i }),
		);

		await waitFor(() => expect(entityMutate).toHaveBeenCalledTimes(1));
		expect(entityMutate).toHaveBeenCalledWith({
			mutation_kind: "mark_project_reviewed",
			payload: { entity_id: "p1" },
		} satisfies EntityMutateParams);
	});

	it("completes a todo inline with its status circle (update_todo)", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "t1" }),
		);
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[todo("t1", "Cut over traffic", { project_id: "p1" })],
			[],
			entityMutate,
		);

		await screen.findByText("Cut over traffic");
		await userEvent.click(
			screen.getByRole("button", { name: /mark todo complete/i }),
		);

		await waitFor(() => expect(entityMutate).toHaveBeenCalledTimes(1));
		const call = entityMutate.mock.calls[0]?.[0] as EntityMutateParams;
		expect(call.mutation_kind).toBe("update_todo");
		expect((call.payload as { todo_id: string }).todo_id).toBe("t1");
		expect((call.payload as { todo: { status: string } }).todo.status).toBe(
			"completed",
		);
	});

	it("selects a todo (opens the rail via ?id) when its body is clicked", async () => {
		const onSelect = vi.fn();
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[todo("t1", "Cut over traffic", { project_id: "p1" })],
			[],
			() => Effect.die("entityMutate not exercised"),
			onSelect,
		);

		await userEvent.click(await screen.findByText("Cut over traffic"));
		expect(onSelect).toHaveBeenCalledWith("t1");
	});

	it("surfaces a failed mark-reviewed as an inline alert", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.fail(
				new InvalidParamsError({
					message: "a completed project is not reviewable",
				}),
			),
		);
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[],
			[],
			entityMutate,
		);

		await screen.findByText("API migration");
		await userEvent.click(
			screen.getByRole("button", { name: /mark reviewed/i }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/not reviewable/i);
		expect(screen.getByText("API migration")).toBeInTheDocument();
	});

	// While the first Core read is still in flight, the view must show the
	// skeleton and NOT seed the session-snapshot queue (an empty list would
	// freeze "All caught up" before any project has loaded).
	it("shows the skeleton while the first read is pending, not a snapshot of projects", () => {
		// A runtime whose reads never resolve, so the query stays pending.
		const never = Effect.never;
		const stub = WsClient.of({
			threadCreate: () => never,
			postMessage: () => never,
			threadList: () => never,
			getRunHistory: () => never,
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => never,
			threadRename: () => never,
			threadArchive: () => never,
			threadUnarchive: () => never,
			threadListArchived: () => never,
			listEntities: () => never,
			getBacklinks: () => never,
			observationQuery: () => never,
			entityMutate: () => never,
			subscribeRun: () => Effect.never as never,
			cancelRun: () => never,
			retryRun: () => never,
			providerStatus: () => never,
			providerLoginStart: () => never,
			modelCatalog: () => never,
			settingsGet: () => never,
			settingsSet: () => never,
			proposalGet: () => never,
			rescanJournalEntry: () => never,
			proposalDecide: () => never,
			messageSearch: () => never,
			proposalNotifications: () => Effect.never as never,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const client = new QueryClient({
			defaultOptions: {
				queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
			},
		});
		render(<ProjectReviewView selectedId={null} onSelect={() => {}} />, {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>
					<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
				</QueryClientProvider>
			),
		});

		// The skeleton renders; no project is focused, so the queue was never
		// seeded while the read was still pending.
		expect(screen.getByTestId("entity-skeleton")).toBeInTheDocument();
		expect(screen.queryByText("API v2 migration")).not.toBeInTheDocument();
		expect(screen.queryByText(/Project \d+ of \d+/)).not.toBeInTheDocument();
	});

	// The session-snapshot mechanic (grill Q12): marking the focused project
	// reviewed advances the cursor to the next due project, and the reviewed one
	// stays in the snapshot so stepping back still reaches it.
	it("advances the cursor after a review and keeps the reviewed project in the snapshot", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "p1" }),
		);
		renderReview(
			[
				project("p1", "First project", {
					next_review_at: "2000-01-01T20:00:00",
				}),
				project("p2", "Second project", {
					next_review_at: "2000-01-02T20:00:00",
				}),
			],
			[],
			[],
			entityMutate,
		);

		await screen.findByText("First project");
		expect(screen.getByText("Project 1 of 2")).toBeInTheDocument();

		// Mark the first reviewed → the cursor advances to the second.
		await userEvent.click(
			screen.getByRole("button", { name: /mark reviewed/i }),
		);
		expect(await screen.findByText("Second project")).toBeInTheDocument();
		expect(screen.getByText("Project 2 of 2")).toBeInTheDocument();

		// Step back: the reviewed first project is still in the snapshot (the count
		// held at 2, and it re-renders), proving it was retained, not dropped.
		await userEvent.click(
			screen.getByRole("button", { name: /previous project/i }),
		);
		expect(await screen.findByText("First project")).toBeInTheDocument();
		expect(screen.getByText("Project 1 of 2")).toBeInTheDocument();
		// Its reviewed state survives the remount (session state is lifted to
		// ReviewQueue, not held in the keyed FocusedProject): the button still reads
		// "Reviewed" and is disabled, not re-enabled to "Mark reviewed".
		expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled();
	});

	// The session-completed todo stays visible CHECKED in place (grill Q13),
	// driven by sessionDone — not by the live status, which the mock leaves
	// 'active'. Removing the sessionDone branch would hide the row's completed
	// presentation, failing this.
	it("keeps an inline-completed todo visible with its completed mark", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "t1" }),
		);
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[todo("t1", "Cut over traffic", { project_id: "p1" })],
			[],
			entityMutate,
		);

		await screen.findByText("Cut over traffic");
		// Before: an active todo's circle is the "Mark todo complete" control.
		await userEvent.click(
			screen.getByRole("button", { name: /mark todo complete/i }),
		);

		// After: the row stays visible and flips to the completed presentation (the
		// circle's aria-label becomes "Completed"). The mock's live row is still
		// 'active', so only sessionDone can produce this.
		expect(
			await screen.findByRole("button", { name: /^completed$/i }),
		).toBeInTheDocument();
		expect(screen.getByText("Cut over traffic")).toBeInTheDocument();
	});
});
