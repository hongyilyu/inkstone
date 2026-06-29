import type { ModelInfo } from "@inkstone/protocol";
import * as sdk from "@inkstone/ui-sdk";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@/test-utils/renderWithQuery";

afterEach(() => {
	cleanup();
	sdk.resetNotificationHandlers();
});

const die = (): Effect.Effect<never, never> => Effect.die("unused");
const dieStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("unused")) as Stream.Stream<never, WsError>;

function makeRuntime(opts: {
	connected?: boolean;
	effort?: string;
	models?: readonly ModelInfo[];
}) {
	const settingsSet = vi.fn((params: { model?: string; effort?: string }) =>
		Effect.succeed({
			provider: "openai-codex",
			model: params.model ?? null,
			effort: params.effort ?? opts.effort ?? "off",
		}),
	);
	const stub = WsClient.of({
		threadCreate: die,
		postMessage: die,
		threadList: die,
		getRunHistory: die,
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: die,
		threadRename: die,
		threadArchive: die,
		threadUnarchive: die,
		threadListArchived: die,
		listEntities: die,
		getBacklinks: die,
		observationQuery: die,
		observationUpdate: die,
		entityMutate: die,
		subscribeRun: dieStream,
		cancelRun: die,
		retryRun: die,
		providerStatus: () =>
			Effect.succeed({
				providers: [{ id: "openai-codex", connected: opts.connected ?? false }],
			}),
		providerLoginStart: () =>
			Effect.succeed({ authorize_url: "https://auth.example/x" }),
		modelCatalog: () =>
			Effect.succeed({
				providers: [
					{ id: "openai-codex", label: "OpenAI", models: opts.models ?? [] },
				],
			}),
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: null,
				effort: opts.effort ?? "off",
			}),
		settingsSet,
		proposalGet: die,
		rescanJournalEntry: die,
		proposalDecide: die,
		messageSearch: die,
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
	});
	return {
		runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
		settingsSet,
	};
}

function renderPage(runtime: ReturnType<typeof makeRuntime>["runtime"]) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
	});
	renderWithQuery(
		<RuntimeProvider runtime={runtime}>
			<RouterProvider router={router} />
		</RuntimeProvider>,
	);
}

describe("Models settings page (ADR-0024)", () => {
	it("reflects provider connection + global effort from the backend", async () => {
		const { runtime } = makeRuntime({ connected: true, effort: "high" });
		renderPage(runtime);

		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/connected/i,
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);
	});

	it("persists an effort change via settings/set", async () => {
		const user = userEvent.setup();
		const { runtime, settingsSet } = makeRuntime({
			connected: false,
			effort: "off",
		});
		renderPage(runtime);

		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);

		await user.click(screen.getByRole("radio", { name: "Max" }));

		await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
		expect(settingsSet).toHaveBeenCalledWith({ effort: "xhigh" });
		// Optimistic update flips the active segment.
		expect(screen.getByRole("radio", { name: "Max" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	it("on a failed effort save, rolls back to the last PERSISTED value, not the pre-click optimistic one", async () => {
		const user = userEvent.setup();
		// Each save rejects (gated), so we control ordering. Persisted starts "low".
		const releases: Array<() => void> = [];
		const settingsSet = vi.fn(() =>
			Effect.promise(
				() => new Promise<void>((_, reject) => releases.push(() => reject())),
			).pipe(Effect.as({ provider: "openai-codex", model: null, effort: "x" })),
		);
		const stub = WsClient.of({
			threadCreate: die,
			postMessage: die,
			threadList: die,
			getRunHistory: die,
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: die,
			threadRename: die,
			threadArchive: die,
			threadUnarchive: die,
			threadListArchived: die,
			listEntities: die,
			getBacklinks: die,
			observationQuery: die,
			observationUpdate: die,
			entityMutate: die,
			subscribeRun: dieStream,
			cancelRun: die,
			retryRun: die,
			providerStatus: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", connected: false }],
				}),
			providerLoginStart: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "low",
				}),
			settingsSet,
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		// Loads persisted "low".
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);

		// Click Max (optimistic), then High (optimistic, newest). Both saves pending.
		await user.click(screen.getByRole("radio", { name: "Max" }));
		await user.click(screen.getByRole("radio", { name: "High" }));
		await waitFor(() => expect(releases).toHaveLength(2));

		// The newest (High) save fails. The OLD bug rolled back to `prev` = the
		// pre-click value captured at High's click = "Max" (never persisted). The
		// fix rolls back to the last persisted value = "Low".
		releases[1]();
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);
		expect(screen.getByRole("radio", { name: "Max" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		// The older (Max) save then also fails — still rolls back to "Low", no flicker to a stale value.
		releases[0]();
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);

		await runtime.dispose();
	});

	it("lists the catalog and persists a preferred model via settings/set", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				reasoning: true,
				input: ["text", "image"],
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 Mini",
				reasoning: true,
				input: ["text", "image"],
			},
		];
		const { runtime, settingsSet } = makeRuntime({ connected: true, models });
		renderPage(runtime);

		const row = await screen.findByRole("row", { name: /GPT-5\.5/ });
		expect(screen.getAllByRole("row")).toHaveLength(2);

		await user.click(
			within(row).getByRole("button", { name: /set as preferred/i }),
		);

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ model: "gpt-5.5" }),
		);
		expect(
			within(await screen.findByRole("row", { name: /GPT-5\.5/ })).getByText(
				/preferred/i,
			),
		).toBeInTheDocument();
	});

	it("ignores an out-of-order save: a stale response cannot overwrite the newer choice", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				reasoning: true,
				input: ["text"],
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 Mini",
				reasoning: true,
				input: ["text"],
			},
		];
		// Gate each settings/set so the FIRST click's response resolves AFTER the
		// second's — the out-of-order interleave the version guard must absorb.
		const releases: Array<() => void> = [];
		const settingsSet = vi.fn((params: { model?: string; effort?: string }) =>
			Effect.promise(
				() => new Promise<void>((resolve) => releases.push(resolve)),
			).pipe(
				Effect.as({
					provider: "openai-codex",
					model: params.model ?? null,
					effort: params.effort ?? "off",
				}),
			),
		);
		const stub = WsClient.of({
			threadCreate: die,
			postMessage: die,
			threadList: die,
			getRunHistory: die,
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: die,
			threadRename: die,
			threadArchive: die,
			threadUnarchive: die,
			threadListArchived: die,
			listEntities: die,
			getBacklinks: die,
			observationQuery: die,
			observationUpdate: die,
			entityMutate: die,
			subscribeRun: dieStream,
			cancelRun: die,
			retryRun: die,
			providerStatus: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", connected: true }],
				}),
			providerLoginStart: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
				}),
			settingsSet,
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		const row55 = await screen.findByRole("row", { name: /GPT-5\.5/ });
		const rowMini = await screen.findByRole("row", { name: /GPT-5\.4 Mini/ });

		// Click 5.5 (first), then Mini (second, the user's latest intent).
		await user.click(
			within(row55).getByRole("button", { name: /set as preferred/i }),
		);
		await user.click(
			within(rowMini).getByRole("button", { name: /set as preferred/i }),
		);
		await waitFor(() => expect(releases).toHaveLength(2));

		// Resolve OUT OF ORDER: the stale first (5.5) lands AFTER the newer (Mini).
		releases[1]();
		releases[0]();

		// The UI must reflect the newer choice (Mini), not the stale first response.
		// Match the "Preferred" badge exactly — NOT the "Set as preferred" button
		// label (which also contains "preferred").
		await waitFor(() =>
			expect(
				within(screen.getByRole("row", { name: /GPT-5\.4 Mini/ })).getByText(
					"Preferred",
				),
			).toBeInTheDocument(),
		);
		expect(
			within(screen.getByRole("row", { name: /GPT-5\.5/ })).queryByText(
				"Preferred",
			),
		).toBeNull();
		// The stale row instead offers "Set as preferred" again (not selected).
		expect(
			within(screen.getByRole("row", { name: /GPT-5\.5/ })).getByRole(
				"button",
				{
					name: /set as preferred/i,
				},
			),
		).toBeInTheDocument();

		await runtime.dispose();
	});
});

// A runtime whose `provider/status` flips false → true across calls: the first
// poll is "Not connected", every poll after a (re)fetch reports "Connected".
// Models the credential write that lands between the first mount-poll and the
// refetch the live push (or focus) triggers.
function makeFlippingRuntime() {
	let calls = 0;
	const providerStatus = vi.fn(() => {
		const connected = calls > 0;
		calls += 1;
		return Effect.succeed({
			providers: [{ id: "openai-codex", connected }],
		});
	});
	const stub = WsClient.of({
		threadCreate: die,
		postMessage: die,
		threadList: die,
		getRunHistory: die,
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: die,
		threadRename: die,
		threadArchive: die,
		threadUnarchive: die,
		threadListArchived: die,
		listEntities: die,
		getBacklinks: die,
		observationQuery: die,
		observationUpdate: die,
		entityMutate: die,
		subscribeRun: dieStream,
		cancelRun: die,
		retryRun: die,
		providerStatus,
		providerLoginStart: () =>
			Effect.succeed({ authorize_url: "https://auth.example/x" }),
		modelCatalog: () =>
			Effect.succeed({
				providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
			}),
		settingsGet: () =>
			Effect.succeed({ provider: "openai-codex", model: null, effort: "off" }),
		settingsSet: () =>
			Effect.succeed({ provider: "openai-codex", model: null, effort: "off" }),
		proposalGet: die,
		rescanJournalEntry: die,
		proposalDecide: die,
		messageSearch: die,
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

describe("Models settings page — provider/connected live push (ADR-0049)", () => {
	it("flips the card to Connected from the live push alone — no window 'focus'", async () => {
		// Capture the closure the page registers under "provider/connected" by
		// spying the SDK seam (the bridge.test.tsx captureRegisteredHandler pattern).
		let pushed: ((params: unknown) => void) | undefined;
		const spy = vi
			.spyOn(sdk, "setNotificationHandler")
			.mockImplementation((method, handler) => {
				if (method === "provider/connected") pushed = handler;
			});

		// Watch every window 'focus' dispatch — the verdict-critical assertion is
		// that the push path NEVER relies on one.
		const focusSpy = vi.fn();
		window.addEventListener("focus", focusSpy);

		try {
			const runtime = makeFlippingRuntime();
			renderPage(runtime);

			// First poll (mount) reports Not connected.
			await waitFor(() =>
				expect(screen.getByTestId("provider-status")).toHaveTextContent(
					/not connected/i,
				),
			);

			if (pushed === undefined) {
				throw new Error(
					'ModelsSettings did not register a "provider/connected" handler',
				);
			}

			// Fire the captured push handler (params ignored) — this alone must
			// trigger a refetch that flips the card.
			pushed({ provider: "openai-codex" });

			await waitFor(() =>
				expect(screen.getByTestId("provider-status")).toHaveTextContent(
					/^connected$/i,
				),
			);

			// No focus event was dispatched anywhere on the push path.
			expect(focusSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			window.removeEventListener("focus", focusSpy);
		}
	});

	it("focus-refetch fallback flips the card in isolation — no push fired", async () => {
		// Regression lock for the existing focus-refetch safety net (ADR-0023),
		// proven independent of the live push: never fire the handler.
		const runtime = makeFlippingRuntime();
		renderPage(runtime);

		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/not connected/i,
			),
		);

		window.dispatchEvent(new Event("focus"));

		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/^connected$/i,
			),
		);
	});
});
