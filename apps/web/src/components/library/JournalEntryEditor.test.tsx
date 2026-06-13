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
import type { JournalEntry } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { JournalEntryEditor } from "./JournalEntryEditor";

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
	props: Parameters<typeof JournalEntryEditor>[0],
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
	return render(<JournalEntryEditor {...props} />, { wrapper: Wrapper });
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
			{ mode: "edit", journalEntry: existing, onDone, onCancel: () => {} },
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
