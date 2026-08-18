import type {
	EntityListResult,
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { InvalidParamsError, type WsError } from "@inkstone/ui-sdk";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { projectRow } from "@test/test-utils/rows";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectReviewView } from "@/components/library/ProjectReviewView";

type Rows = EntityListResult["entities"];

type EntityMutate = (
	params: EntityMutateParams,
) => Effect.Effect<EntityMutateResult, WsError>;

function renderReview(
	projects: Rows,
	entityMutate: EntityMutate = () => Effect.die("entityMutate not exercised"),
) {
	return renderWithCore(<ProjectReviewView />, {
		entities: { project: projects },
		overrides: { entityMutate },
	});
}

// Past = unambiguously due regardless of real "now"; far future = never due.
const PAST = "2000-01-01T20:00:00";
const FUTURE = "2999-01-01T20:00:00";

afterEach(cleanup);

describe("ProjectReviewView (focused queue)", () => {
	it("focuses one due project with a position counter, excludes future/terminal", async () => {
		renderReview([
			projectRow("p_active", "Active due", { next_review_at: PAST }),
			projectRow("p_hold", "On hold due", {
				status: "on_hold",
				next_review_at: PAST,
			}),
			projectRow("p_future", "Not yet due", { next_review_at: FUTURE }),
			projectRow("p_done", "Completed", {
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
			projectRow("p1", "First project", {
				next_review_at: "2000-01-01T20:00:00",
			}),
			projectRow("p2", "Second project", {
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

	it("renders the cadence label, last-reviewed, and the project's outcome", async () => {
		renderReview([
			projectRow("p1", "API migration", {
				next_review_at: PAST,
				last_reviewed_at: "2026-06-01T20:00:00",
				review_every: { interval: 1, unit: "week" },
				outcome: "Cut over traffic to /v2.",
			}),
		]);

		expect(await screen.findByText("API migration")).toBeInTheDocument();
		expect(screen.getByText("Every week")).toBeInTheDocument();
		expect(screen.getByText(/Last reviewed 2026-06-01/)).toBeInTheDocument();
		expect(screen.getByText("Cut over traffic to /v2.")).toBeInTheDocument();
	});

	it("teaches the empty state when nothing is due", async () => {
		renderReview([projectRow("p_future", "Later", { next_review_at: FUTURE })]);
		expect(await screen.findByText("All caught up")).toBeInTheDocument();
	});

	it("marks the focused project reviewed with an entity_id-only mutation (ADR-0034)", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.succeed({ entity_id: "p1" }),
		);
		renderReview(
			[projectRow("p1", "API migration", { next_review_at: PAST })],
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

	it("surfaces a failed mark-reviewed as an inline alert", async () => {
		const entityMutate = vi.fn<EntityMutate>(() =>
			Effect.fail(
				new InvalidParamsError({
					message: "a completed project is not reviewable",
				}),
			),
		);
		renderReview(
			[projectRow("p1", "API migration", { next_review_at: PAST })],
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
	it("shows the skeleton while the first read is pending, not a snapshot of projects", async () => {
		// A runtime whose reads never resolve, so the query stays pending.
		await renderWithCore(<ProjectReviewView />, {
			overrides: { listEntities: () => Effect.never },
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
				projectRow("p1", "First project", {
					next_review_at: "2000-01-01T20:00:00",
				}),
				projectRow("p2", "Second project", {
					next_review_at: "2000-01-02T20:00:00",
				}),
			],
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
});
