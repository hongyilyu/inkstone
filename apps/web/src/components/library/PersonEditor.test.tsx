import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient, type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Person } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { PersonEditor } from "./PersonEditor";

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
		getRunHistory: () => unused,
		recurrencePreview: () => Effect.die("not exercised in this test"),
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
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderEditor(
	props: Parameters<typeof PersonEditor>[0],
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
	return render(<PersonEditor {...props} />, { wrapper: Wrapper });
}

const existing: Person = {
	id: "01900000-0000-7000-8000-0000000000a1",
	kind: "person",
	name: "Alice",
	recency: 1,
	createdAt: "fixture",
};

afterEach(cleanup);

describe("PersonEditor Save gate", () => {
	// The required-field guard must be legible: an empty name leaves Save disabled
	// (not a dead control that swallows the click). Typing a name enables it.
	it("disables Save while the name is empty and enables it once filled", async () => {
		const user = userEvent.setup();
		renderEditor({ mode: "create", onDone: () => {}, onCancel: () => {} });

		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeDisabled();

		await user.type(screen.getByLabelText(/name/i), "Bob");
		expect(save).toBeEnabled();
	});
});

describe("PersonEditor create", () => {
	it("emits create_person with only the filled fields", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor({ mode: "create", onDone, onCancel: () => {} }, (params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000099",
			});
		});

		await user.type(screen.getByLabelText(/name/i), "Bob");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_person",
			payload: { name: "Bob" },
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("includes note and aliases as a plain string[] when given", async () => {
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

		await user.type(screen.getByLabelText(/name/i), "Bob");
		await user.type(screen.getByLabelText(/note/i), "Met at the daycare");
		await user.type(screen.getByLabelText(/also known as/i), "Bobby, Rob");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_person",
			payload: {
				name: "Bob",
				note: "Met at the daycare",
				aliases: ["Bobby", "Rob"],
			},
		});
	});
});

describe("PersonEditor edit", () => {
	// Core's update_person is a full-document REPLACE, not a merge: editing only the
	// name must still carry the Person's note + aliases, or those fields are WIPED.
	it("replays note + aliases when only the name changes", async () => {
		const withOptionals: Person = {
			...existing,
			note: "Met at the daycare",
			aliases: ["Ally", "A."],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", person: withOptionals, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withOptionals.id });
			},
		);

		const name = screen.getByLabelText(/name/i);
		await user.clear(name);
		await user.type(name, "Alice Smith");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_person",
			payload: {
				entity_id: withOptionals.id,
				name: "Alice Smith",
				note: "Met at the daycare",
				aliases: ["Ally", "A."],
			},
		});
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(withOptionals.id));
	});

	// A WsRequestError is an Error but its `.message` is "" (its text lives in
	// `.reason`). The alert must fall through to the static copy, never render blank.
	it("shows the static fallback when the mutation fails with a blank-message WsRequestError", async () => {
		const user = userEvent.setup();
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", person: existing, onDone, onCancel: () => {} },
			() => Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);

		const name = screen.getByLabelText(/name/i);
		await user.clear(name);
		await user.type(name, "Alice Smith");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't save. Try again.");
		// The raw WsRequestError `.reason` token must never surface as user copy.
		expect(alert).not.toHaveTextContent("connection_lost");
		expect(onDone).not.toHaveBeenCalled();
	});

	it("does nothing when no field changed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", person: existing, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
		expect(seen).toHaveLength(0);
	});

	// Under full-replace, clearing an optional means it's simply absent from the
	// replaced document (omit ≡ null — ADR-0033). `name` always rides along because
	// Core's update_person validator requires it (slice 2 schema).
	it("omits note and aliases from the full doc when cleared, name still present", async () => {
		const withOptionals: Person = {
			...existing,
			note: "Old note",
			aliases: ["Ally"],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				person: withOptionals,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withOptionals.id });
			},
		);

		await user.clear(screen.getByLabelText(/note/i));
		await user.clear(screen.getByLabelText(/also known as/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_person",
			payload: { entity_id: withOptionals.id, name: "Alice" },
		});
	});
});
