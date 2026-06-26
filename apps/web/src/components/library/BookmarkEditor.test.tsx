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
import type { Bookmark } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { BookmarkEditor } from "./BookmarkEditor";

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
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderEditor(
	props: Parameters<typeof BookmarkEditor>[0],
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
	return render(<BookmarkEditor {...props} />, { wrapper: Wrapper });
}

const existing: Bookmark = {
	id: "01900000-0000-7000-8000-0000000000b1",
	kind: "bookmark",
	title: "Effect docs",
	recency: 1,
	createdAt: "fixture",
};

afterEach(cleanup);

describe("BookmarkEditor create", () => {
	it("emits create_bookmark with only the filled fields", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor({ mode: "create", onDone, onCancel: () => {} }, (params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000099",
			});
		});

		await user.type(screen.getByLabelText(/title/i), "Effect docs");
		await user.type(screen.getByLabelText(/url/i), "https://effect.website");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_bookmark",
			payload: { title: "Effect docs", url: "https://effect.website" },
		});
		await waitFor(() =>
			expect(onDone).toHaveBeenCalledWith(
				"01900000-0000-7000-8000-000000000099",
			),
		);
	});

	it("includes note and tags as a plain string[] when given", async () => {
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

		await user.type(screen.getByLabelText(/title/i), "Effect docs");
		await user.type(screen.getByLabelText(/note/i), "Great reference");
		await user.type(screen.getByLabelText(/tags/i), "effect, ts");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "create_bookmark",
			payload: {
				title: "Effect docs",
				note: "Great reference",
				tags: ["effect", "ts"],
			},
		});
	});

	it("dedups repeated tags before sending", async () => {
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

		await user.type(screen.getByLabelText(/title/i), "Effect docs");
		await user.type(screen.getByLabelText(/tags/i), "effect, ts, effect");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].payload).toEqual({
			title: "Effect docs",
			tags: ["effect", "ts"],
		});
	});

	it("blocks Save when the title is empty", async () => {
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

		await user.type(screen.getByLabelText(/url/i), "https://effect.website");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(seen).toHaveLength(0);
	});
});

describe("BookmarkEditor edit", () => {
	// Core's update_bookmark is a full-document REPLACE, not a merge: editing only
	// the title must still carry url + note + tags, or those fields are WIPED.
	it("replays url, note + tags when only the title changes", async () => {
		const withOptionals: Bookmark = {
			...existing,
			url: "https://effect.website",
			note: "Great reference",
			tags: ["effect", "ts"],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const onDone = vi.fn();
		renderEditor(
			{ mode: "edit", bookmark: withOptionals, onDone, onCancel: () => {} },
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withOptionals.id });
			},
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "Effect — docs");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_bookmark",
			payload: {
				entity_id: withOptionals.id,
				title: "Effect — docs",
				url: "https://effect.website",
				note: "Great reference",
				tags: ["effect", "ts"],
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
			{ mode: "edit", bookmark: existing, onDone, onCancel: () => {} },
			() => Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);

		const title = screen.getByLabelText(/title/i);
		await user.clear(title);
		await user.type(title, "Effect — docs");
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
			{ mode: "edit", bookmark: existing, onDone, onCancel: () => {} },
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
	// replaced document (omit ≡ null). `title` always rides along because Core's
	// update_bookmark validator requires it.
	it("omits url, note and tags from the full doc when cleared, title still present", async () => {
		const withOptionals: Bookmark = {
			...existing,
			url: "https://effect.website",
			note: "Old note",
			tags: ["effect"],
		};
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		renderEditor(
			{
				mode: "edit",
				bookmark: withOptionals,
				onDone: () => {},
				onCancel: () => {},
			},
			(params) => {
				seen.push(params);
				return Effect.succeed({ entity_id: withOptionals.id });
			},
		);

		await user.clear(screen.getByLabelText(/url/i));
		await user.clear(screen.getByLabelText(/note/i));
		await user.clear(screen.getByLabelText(/tags/i));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({
			mutation_kind: "update_bookmark",
			payload: { entity_id: withOptionals.id, title: "Effect docs" },
		});
	});
});
