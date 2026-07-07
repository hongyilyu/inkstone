import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import type { WsError } from "@inkstone/ui-sdk";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/components/library/ProjectEditor";
import type { Project } from "@/lib/libraryItems";

// Render under the shared Core harness: `entityMutate` records params and
// succeeds; unused methods die.
function renderEditor(
	props: Parameters<typeof ProjectEditor>[0],
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
) {
	return renderWithCore(<ProjectEditor {...props} />, {
		overrides: { entityMutate },
	});
}

const existing: Project = {
	id: "01900000-0000-7000-8000-0000000000b1",
	kind: "project",
	name: "Daycare move",
	status: "active",
	recency: 1,
	createdAt: "fixture",
	// The complete stored data the editor must replay into a full-document-replace
	// update_project. Carries the server-managed review ritual the form never shows.
	data: {
		name: "Daycare move",
		status: "active",
		review_every: "P1W",
		next_review_at: "2026-06-21T20:00:00",
	},
};

afterEach(cleanup);

describe("ProjectEditor create", () => {
	it("emits create_project with only the filled fields (no review_every)", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor({ mode: "create", onDone, onCancel: () => {} }, (params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000099",
			});
		});

		await user.type(screen.getByLabelText(/name/i), "Garden");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		// Active status is the default and is omitted; Core injects the review ritual.
		expect(seen[0]).toEqual({
			mutation_kind: "create_project",
			payload: { name: "Garden" },
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("includes outcome and note when given", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-000000000099",
				});
			},
		);

		await user.type(screen.getByLabelText(/name/i), "Garden");
		await user.type(screen.getByLabelText(/outcome/i), "Beds planted");
		await user.type(screen.getByLabelText(/note/i), "Spring project");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_project",
			payload: {
				name: "Garden",
				outcome: "Beds planted",
				note: "Spring project",
			},
		});
	});
});

describe("ProjectEditor edit", () => {
	// THE key regression test (slice-7 iter-1 bug): Core's update_project is a
	// full-document REPLACE, not a merge. The editor must replay every stored
	// field — including the server-managed review ritual the form never renders —
	// or editing one field WIPES the rest. Editing only `outcome` must still carry
	// review_every + next_review_at + name in the emitted payload.
	it("replays the full stored document when only outcome changes", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", project: existing, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.type(screen.getByLabelText(/outcome/i), "Moved in");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_project",
			payload: {
				entity_id: existing.id,
				name: "Daycare move",
				status: "active",
				review_every: "P1W",
				next_review_at: "2026-06-21T20:00:00",
				outcome: "Moved in",
			},
		});
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
	});

	// A non-name edit (status only) must still include `name`: Core's
	// validate_project requires it on every update or the write is rejected.
	it("includes name (and the full doc) when only status changes", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "edit", project: existing, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.selectOptions(screen.getByLabelText(/status/i), "on_hold");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		expect(payload.name).toBe("Daycare move");
		expect(payload.status).toBe("on_hold");
		// Server-managed fields survive the edit.
		expect(payload.review_every).toBe("P1W");
		expect(payload.next_review_at).toBe("2026-06-21T20:00:00");
	});

	it("does nothing when no field changed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", project: existing, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
		expect(seen).toHaveLength(0);
	});

	it("drops outcome from the full doc when an existing outcome is cleared", async () => {
		const withOutcome: Project = {
			...existing,
			outcome: "Old goal",
			data: { ...existing.data, outcome: "Old goal" },
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				project: withOutcome,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withOutcome.id });
			},
		);

		await user.clear(screen.getByLabelText(/outcome/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		// Under full-replace, a cleared optional is simply absent (omit ≡ null).
		expect("outcome" in payload).toBe(false);
		// The rest of the document is preserved.
		expect(payload.name).toBe("Daycare move");
		expect(payload.review_every).toBe("P1W");
	});

	// The slice-6 lesson: a status change must clear the now-invalid timestamp(s)
	// so Core's re-validation of the replaced document doesn't trip on a stale
	// `completed_at`/`dropped_at` (ADR-0033).
	it("clears completed_at and dropped_at when leaving a terminal status", async () => {
		const completed: Project = {
			...existing,
			status: "completed",
			data: {
				...existing.data,
				status: "completed",
				completed_at: "2026-06-01T12:00:00",
			},
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				project: completed,
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
		const payload = seen[0].payload as Record<string, unknown>;
		expect(payload.status).toBe("active");
		expect(payload.name).toBe("Daycare move");
		// The terminal timestamps are dropped from the replaced document.
		expect("completed_at" in payload).toBe(false);
		expect("dropped_at" in payload).toBe(false);
		// Review ritual is preserved.
		expect(payload.review_every).toBe("P1W");
	});

	// Editing a terminal Project WITHOUT changing its status must PRESERVE the
	// original timestamp — re-stamping `completed_at`/`dropped_at` on every edit
	// would silently rewrite when the project was finished (ADR-0033).
	it("preserves the stored completed_at when status is unchanged", async () => {
		const completed: Project = {
			...existing,
			status: "completed",
			outcome: "Old goal",
			data: {
				...existing.data,
				status: "completed",
				outcome: "Old goal",
				completed_at: "2026-06-01T12:00:00",
			},
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				project: completed,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: completed.id });
			},
		);

		// Edit only the outcome; status stays "completed".
		await user.clear(screen.getByLabelText(/outcome/i));
		await user.type(screen.getByLabelText(/outcome/i), "Moved in");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		expect(payload.status).toBe("completed");
		expect(payload.outcome).toBe("Moved in");
		// The original completion timestamp survives — NOT re-stamped to today.
		expect(payload.completed_at).toBe("2026-06-01T12:00:00");
	});

	it("clears dropped_at and sets completed_at on active→completed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "edit", project: existing, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.selectOptions(screen.getByLabelText(/status/i), "completed");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		expect(payload.entity_id).toBe(existing.id);
		expect(payload.name).toBe("Daycare move");
		expect(payload.status).toBe("completed");
		expect("dropped_at" in payload).toBe(false);
		expect(typeof payload.completed_at).toBe("string");
	});
});
