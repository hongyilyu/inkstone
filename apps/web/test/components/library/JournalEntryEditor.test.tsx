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
import { JournalEntryEditor } from "@/components/library/JournalEntryEditor";
import type { JournalEntry, LibraryItem } from "@/lib/libraryItems";

// Render under the shared Core harness: `entityMutate` records params and
// succeeds; unused methods die.
function renderEditor(
	props: Parameters<typeof JournalEntryEditor>[0],
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
) {
	return renderWithCore(<JournalEntryEditor {...props} />, {
		overrides: { entityMutate },
	});
}

const REF_A = "01900000-0000-7000-8000-0000000000a1";
const REF_B = "01900000-0000-7000-8000-0000000000a2";

const existing: JournalEntry = {
	id: "01900000-0000-7000-8000-0000000000e1",
	kind: "journal_entry",
	occurredAt: "2026-06-10T10:30:00",
	endedAt: "2026-06-10T10:45:00",
	body: [
		{ type: "text", text: "Spoke with " },
		{
			type: "entity_ref",
			refId: REF_A,
			targetEntityId: "01900000-0000-7000-8000-0000000000a1",
			targetTitle: "Alice",
		},
		{ type: "text", text: " about " },
		{
			type: "entity_ref",
			refId: REF_B,
			targetEntityId: "01900000-0000-7000-8000-0000000000a2",
			targetTitle: "Daycare move",
		},
		{ type: "text", text: " plans." },
	],
	recency: 1,
	createdAt: "fixture",
};

const PERSON_BOB: LibraryItem = {
	id: "01900000-0000-7000-8000-0000000000b1",
	kind: "person",
	name: "Bob",
	recency: 2,
	createdAt: "fixture",
};

const PROJECT_DEMO: LibraryItem = {
	id: "01900000-0000-7000-8000-0000000000c1",
	kind: "project",
	name: "Demo project",
	status: "active",
	recency: 3,
	createdAt: "fixture",
};

// A text-only Journal Entry to attach new chips to — keeps the add-chip body
// assertions free of pre-existing chips so the ONE-placeholder rule is unambiguous.
const textOnlyEntry: JournalEntry = {
	id: "01900000-0000-7000-8000-0000000000e2",
	kind: "journal_entry",
	occurredAt: "2026-06-10T10:30:00",
	endedAt: undefined,
	body: [{ type: "text", text: "Standup notes." }],
	recency: 1,
	createdAt: "fixture",
};

afterEach(cleanup);

describe("JournalEntryEditor create", () => {
	it("emits create_journal_entry with a text-only body and occurred_at", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor({ mode: "create", onDone, onCancel: () => {} }, (params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000099",
			});
		});

		await user.clear(screen.getByLabelText(/occurred at/i));
		await user.type(screen.getByLabelText(/occurred at/i), "2026-06-12T09:00");
		await user.type(screen.getByLabelText(/^body$/i), "Quick standup notes.");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_journal_entry",
			payload: {
				occurred_at: "2026-06-12T09:00:00",
				body: [{ type: "text", text: "Quick standup notes." }],
			},
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("includes ended_at when an end time is given", async () => {
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

		await user.clear(screen.getByLabelText(/occurred at/i));
		await user.type(screen.getByLabelText(/occurred at/i), "2026-06-12T09:00");
		await user.type(screen.getByLabelText(/ended at/i), "2026-06-12T09:30");
		await user.type(screen.getByLabelText(/^body$/i), "Pairing session.");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_journal_entry",
			payload: {
				occurred_at: "2026-06-12T09:00:00",
				ended_at: "2026-06-12T09:30:00",
				body: [{ type: "text", text: "Pairing session." }],
			},
		});
	});

	// Defense-in-depth (EntityEditorFrame guard): while a save is in flight, the
	// Save button is disabled, but a form submit (Enter) must NOT fire a second
	// mutation. Hold the first mutation pending so `saving` stays true, then submit
	// again via Enter and assert exactly one write reached Core.
	it("does not fire a second mutation while a save is in flight", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				// Never resolves — the mutation stays pending (saving = true).
				return Effect.never;
			},
		);

		await user.clear(screen.getByLabelText(/occurred at/i));
		await user.type(screen.getByLabelText(/occurred at/i), "2026-06-12T09:00");
		const body = screen.getByLabelText(/^body$/i);
		await user.type(body, "Quick note.");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		// Pressing Enter in the body re-submits the form; the in-flight guard drops it.
		await user.type(body, "{Enter}");
		expect(seen).toHaveLength(1);
	});

	it("prevents save when the body is empty", async () => {
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

		await user.clear(screen.getByLabelText(/occurred at/i));
		await user.type(screen.getByLabelText(/occurred at/i), "2026-06-12T09:00");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// No write — the empty body is rejected client-side before reaching Core.
		expect(seen).toHaveLength(0);
	});
});

describe("JournalEntryEditor edit", () => {
	// THE chip-preserve regression (slice-6 bug class): a kept chip rides the wire
	// as snake_case `{type:"entity_ref", ref_id}` carrying the REAL stored ref_id —
	// never camelCase `refId`. And the full-replace update must carry occurred_at +
	// ended_at unchanged so editing the text doesn't drop the stored end time (trap 1).
	it("keeps existing chips as snake_case entity_ref nodes and preserves occurred_at/ended_at", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{
				mode: "edit",
				journalEntry: existing,
				allEntities: [],
				onDone,
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		// Edit the trailing text segment (the last "Body" control); keep both chips.
		const bodyInputs = screen.getAllByLabelText("Body");
		const lastText = bodyInputs[bodyInputs.length - 1];
		await user.clear(lastText);
		await user.type(lastText, " plans for next week.");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_journal_entry",
			payload: {
				entity_id: existing.id,
				occurred_at: "2026-06-10T10:30:00",
				ended_at: "2026-06-10T10:45:00",
				body: [
					{ type: "text", text: "Spoke with " },
					{ type: "entity_ref", ref_id: REF_A },
					{ type: "text", text: " about " },
					{ type: "entity_ref", ref_id: REF_B },
					{ type: "text", text: " plans for next week." },
				],
			},
		});
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
	});

	it("omits a removed chip from the emitted body", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				journalEntry: existing,
				allEntities: [],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		// Remove the first chip (Alice); the second chip (REF_B) survives.
		await user.click(screen.getByRole("button", { name: /remove alice/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as {
			body: Array<{ type: string; ref_id?: string }>;
		};
		const refNodes = payload.body.filter((n) => n.type === "entity_ref");
		// Only the kept chip rides through — snake_case ref_id, real stored id.
		expect(refNodes).toEqual([{ type: "entity_ref", ref_id: REF_B }]);
		// The removed chip's id is absent entirely.
		expect(JSON.stringify(payload.body)).not.toContain(REF_A);
		expect(JSON.stringify(payload.body)).not.toContain("refId");
	});

	it("can drop ended_at when the end time is cleared", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				journalEntry: existing,
				allEntities: [],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.clear(screen.getByLabelText(/ended at/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		expect("ended_at" in payload).toBe(false);
		expect(payload.occurred_at).toBe("2026-06-10T10:30:00");
	});

	// Sub-minute precision trap: `datetime-local` is minute-precision, so a body-only
	// edit must NOT re-stamp a stored occurred_at's seconds to :00. The untouched time
	// rides the wire byte-identical.
	it("preserves stored occurred_at seconds on a body-only edit", async () => {
		const withSeconds: JournalEntry = {
			...existing,
			occurredAt: "2026-06-10T10:30:45",
			endedAt: undefined,
			body: [{ type: "text", text: "Standup." }],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				journalEntry: withSeconds,
				allEntities: [],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withSeconds.id });
			},
		);

		// Edit only the body text; never touch the "Occurred at" input.
		await user.clear(screen.getByLabelText(/^body$/i));
		await user.type(screen.getByLabelText(/^body$/i), "Standup notes.");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		const payload = seen[0].payload as Record<string, unknown>;
		expect(payload.occurred_at).toBe("2026-06-10T10:30:45");
	});

	it("prevents save when removing every body node would empty the body", async () => {
		const textOnly: JournalEntry = {
			...existing,
			body: [{ type: "text", text: "Solo note." }],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				journalEntry: textOnly,
				allEntities: [],
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: textOnly.id });
			},
		);

		await user.clear(screen.getByDisplayValue("Solo note."));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(seen).toHaveLength(0);
	});
});

describe("JournalEntryEditor add chip", () => {
	const allEntities: LibraryItem[] = [PERSON_BOB, PROJECT_DEMO, existing];

	// Adding ONE new chip is its own reference mutation, NOT an update: it carries
	// {source_entity_id (this JE), target_entity_id (the picked entity), body with
	// EXACTLY ONE bare {type:"entity_ref"} placeholder for the new chip}.
	it("adds a chip linking a Person via exactly one reference_existing mutation", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{
				mode: "edit",
				journalEntry: textOnlyEntry,
				allEntities,
				onDone,
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: textOnlyEntry.id });
			},
		);

		// Open the picker, search for Bob, and pick him to stage a new chip.
		await user.click(screen.getByRole("button", { name: /add reference/i }));
		await user.type(screen.getByLabelText(/link an entity/i), "Bob");
		await user.click(screen.getByRole("option", { name: /bob/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		const payload = seen[0].payload as {
			source_entity_id: string;
			target_entity_id: string;
			label_snapshot?: string;
			body: Array<{ type: string; ref_id?: string }>;
		};
		expect(payload.source_entity_id).toBe(textOnlyEntry.id);
		expect(payload.target_entity_id).toBe(PERSON_BOB.id);
		expect(payload.label_snapshot).toBe("Bob");
		// EXACTLY ONE placeholder — a bare entity_ref with NO ref_id (Core mints it).
		const refNodes = payload.body.filter((n) => n.type === "entity_ref");
		expect(refNodes).toEqual([{ type: "entity_ref" }]);
		expect(JSON.stringify(payload.body)).not.toContain("ref_id");
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(textOnlyEntry.id));
	});

	// The reference mutation carries NO occurred_at/ended_at — Core preserves the
	// stored scalars and replaces only the body. So a date edit made in the SAME Save
	// as staging a chip must NOT be silently dropped: the editor first emits an
	// update_journal_entry for the scalar change, THEN the reference mutation — in order.
	it("persists a date edit via update_journal_entry before referencing the chip", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{
				mode: "edit",
				journalEntry: textOnlyEntry,
				allEntities,
				onDone,
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: textOnlyEntry.id });
			},
		);

		// Change the occurred time AND stage a new chip in the same edit.
		await user.clear(screen.getByLabelText(/occurred at/i));
		await user.type(screen.getByLabelText(/occurred at/i), "2026-06-11T08:15");
		await user.click(screen.getByRole("button", { name: /add reference/i }));
		await user.type(screen.getByLabelText(/link an entity/i), "Bob");
		await user.click(screen.getByRole("option", { name: /bob/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// Two mutations, IN ORDER: the scalar update first, then the reference.
		await waitFor(() => expect(seen).toHaveLength(2));
		expect(seen[0]).toEqual({
			mutation_kind: "update_journal_entry",
			payload: {
				entity_id: textOnlyEntry.id,
				occurred_at: "2026-06-11T08:15:00",
				body: [{ type: "text", text: "Standup notes." }],
			},
		});
		expect(seen[1].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		const refPayload = seen[1].payload as {
			target_entity_id: string;
			occurred_at?: string;
		};
		expect(refPayload.target_entity_id).toBe(PERSON_BOB.id);
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(textOnlyEntry.id));
	});

	// No date edit ⇒ no spurious update: a chip add alone is a single reference mutation.
	it("does not emit an update when only a chip is added (date untouched)", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				journalEntry: textOnlyEntry,
				allEntities,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: textOnlyEntry.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /add reference/i }));
		await user.type(screen.getByLabelText(/link an entity/i), "Bob");
		await user.click(screen.getByRole("option", { name: /bob/i }));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
	});

	// Core supports AT MOST ONE chip per JE via reference_existing (the body must
	// carry exactly one bare placeholder and the mutation full-replaces the body).
	// So the "Add reference" affordance is gated to chip-FREE entries: when the JE
	// already has a chip, the affordance is absent (with a brief hint instead).
	it("hides the add-reference affordance when the entry already has a chip", () => {
		renderEditor({
			mode: "edit",
			journalEntry: existing, // body carries two existing entity_ref chips
			allEntities,
			onDone: () => {},
			onCancel: () => {},
		});

		expect(
			screen.queryByRole("button", { name: /add reference/i }),
		).not.toBeInTheDocument();
		// A brief hint explains the one-reference-per-entry limit.
		expect(screen.getByText(/one reference per entry/i)).toBeInTheDocument();
	});
});
