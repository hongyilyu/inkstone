import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient, type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Media } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { MediaEditor } from "./MediaEditor";

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
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		observationQuery: () => unused,
		observationUpdate: () => unused,
		entityMutate,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		providerConfigure: () => unused,
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
	props: Parameters<typeof MediaEditor>[0],
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
	return render(<MediaEditor {...props} />, { wrapper: Wrapper });
}

const existing: Media = {
	id: "01900000-0000-7000-8000-0000000000b1",
	kind: "media",
	title: "The Pragmatic Programmer",
	medium: "book",
	state: "backlog",
	recency: 1,
	createdAt: "fixture",
};

afterEach(cleanup);

describe("MediaEditor create", () => {
	it("emits create_media with the title, medium, and state (a non-terminal state omits rating/finished)", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor({ mode: "create", onDone, onCancel: () => {} }, (params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000099",
			});
		});

		await user.type(screen.getByLabelText(/title/i), "Dune");
		await user.selectOptions(screen.getByLabelText(/medium/i), "book");
		await user.selectOptions(screen.getByLabelText(/state/i), "consuming");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_media",
			payload: { title: "Dune", medium: "book", state: "consuming" },
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("blocks Save when the title is empty (medium/state alone do not save)", async () => {
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

		await user.selectOptions(screen.getByLabelText(/medium/i), "movie");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(seen).toHaveLength(0);
	});

	it("hides rating + finished inputs while the state is non-terminal, reveals them on a terminal state", async () => {
		const user = userEvent.setup();
		renderEditor({ mode: "create", onDone: () => {}, onCancel: () => {} });

		// Default state is backlog (non-terminal) → no rating/finished fields.
		expect(screen.queryByLabelText(/rating/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/finished/i)).not.toBeInTheDocument();

		// Flip to a terminal state → both appear.
		await user.selectOptions(screen.getByLabelText(/state/i), "done");
		expect(screen.getByLabelText(/rating/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/finished/i)).toBeInTheDocument();
	});

	it("emits rating + finished_at on a terminal state", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-0000000000a1",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "The Matrix");
		await user.selectOptions(screen.getByLabelText(/medium/i), "movie");
		await user.selectOptions(screen.getByLabelText(/state/i), "done");
		await user.type(screen.getByLabelText(/rating/i), "5");
		await user.type(screen.getByLabelText(/finished/i), "2026-06-20");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_media",
			payload: {
				title: "The Matrix",
				medium: "movie",
				state: "done",
				rating: 5,
				finished_at: "2026-06-20T00:00:00",
			},
		});
	});

	it("never emits rating/finished_at once the state leaves terminal (cleared on the flip)", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "create", onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({
					entity_id: "01900000-0000-7000-8000-0000000000a2",
				});
			},
		);

		await user.type(screen.getByLabelText(/title/i), "Inception");
		await user.selectOptions(screen.getByLabelText(/medium/i), "movie");
		// Enter terminal, fill rating, then flip back to non-terminal.
		await user.selectOptions(screen.getByLabelText(/state/i), "done");
		await user.type(screen.getByLabelText(/rating/i), "4");
		await user.selectOptions(screen.getByLabelText(/state/i), "consuming");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		// Core rejects rating/finished on a non-terminal state; the editor must omit them.
		expect(seen[0]).toEqual({
			mutation_kind: "create_media",
			payload: { title: "Inception", medium: "movie", state: "consuming" },
		});
	});
});

describe("MediaEditor edit", () => {
	// Core's update_media is a full-document REPLACE, not a merge: editing only the
	// title must still carry medium + state, or those required fields are lost.
	it("replays medium + state when only the title changes", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", media: existing, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "The Pragmatic Programmer (2nd ed)");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_media",
			payload: {
				entity_id: existing.id,
				title: "The Pragmatic Programmer (2nd ed)",
				medium: "book",
				state: "backlog",
			},
		});
		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
	});

	// A WsRequestError is an Error but its `.message` is "" (its text lives in
	// `.reason`). The alert must fall through to the static copy, never render blank.
	it("shows the static fallback when the mutation fails with a blank-message WsRequestError", async () => {
		const user = userEvent.setup();
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", media: existing, onDone, onCancel: () => {} },
			() => Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "Renamed");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't save. Try again.");
		expect(alert).not.toHaveTextContent("connection_lost");
		expect(onDone).not.toHaveBeenCalled();
	});

	it("does nothing when no field changed", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", media: existing, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: existing.id });
			},
		);

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(onDone).toHaveBeenCalledWith(existing.id));
		expect(seen).toHaveLength(0);
	});

	// Clearing the rating on a terminal-state Media drops it from the full doc (omit
	// ≡ null), while medium/state/title ride along.
	it("omits a cleared rating from the full doc, terminal state still present", async () => {
		const done: Media = {
			...existing,
			state: "done",
			rating: 5,
			finishedAt: "2026-06-20T00:00:00",
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{ mode: "edit", media: done, onDone: () => {}, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: done.id });
			},
		);

		await user.clear(screen.getByLabelText(/rating/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_media",
			payload: {
				entity_id: done.id,
				title: "The Pragmatic Programmer",
				medium: "book",
				state: "done",
				finished_at: "2026-06-20T00:00:00",
			},
		});
	});
});
