import type { ModelInfo, ProviderStatusResult } from "@inkstone/protocol";
import * as sdk from "@inkstone/ui-sdk";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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
	model?: string | null;
	enabledModels?: readonly string[];
	// When set, a second provider row (OpenRouter) rides in provider/status +
	// model/catalog so the key-Configure affordance can be exercised. Its
	// connected flag flips to `true` once providerConfigure is called (mirroring
	// Core's post-configure provider/status refresh).
	withOpenRouter?: boolean;
	// The verdict provider/test resolves to (ADR-0062). When omitted the
	// providerTest stub dies (it isn't exercised); tests that click "Test" set it.
	testResult?: { alive: boolean; message?: string };
}) {
	// Flips false → true after the first successful provider/configure call, so
	// the row reflects "Connected" once the key is stored.
	let openrouterConnected = false;
	const settingsSet = vi.fn(
		(params: {
			model?: string;
			effort?: string;
			enabled_models?: readonly string[];
		}) =>
			Effect.succeed({
				provider: "openai-codex",
				model: params.model ?? null,
				effort: params.effort ?? opts.effort ?? "off",
				enabled_models: params.enabled_models ?? [],
			}),
	);
	const providerConfigure = vi.fn((_provider: string, _apiKey: string) => {
		openrouterConnected = true;
		return Effect.succeed({
			providers: [
				{
					id: "openai-codex",
					connected: opts.connected ?? false,
					auth_kind: "oauth" as const,
				},
				{ id: "openrouter", connected: true, auth_kind: "api_key" as const },
			],
		});
	});
	const providerTest = vi.fn((_provider: string, _model: string) =>
		opts.testResult === undefined
			? Effect.die("provider/test not exercised")
			: Effect.succeed(opts.testResult),
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
				providers: [
					{
						id: "openai-codex",
						connected: opts.connected ?? false,
						auth_kind: "oauth" as const,
					},
					...(opts.withOpenRouter
						? [
								{
									id: "openrouter",
									connected: openrouterConnected,
									auth_kind: "api_key" as const,
								},
							]
						: []),
				],
			}),
		providerLoginStart: () =>
			Effect.succeed({ authorize_url: "https://auth.example/x" }),
		providerConfigure,
		providerTest,
		modelCatalog: () =>
			Effect.succeed({
				providers: [
					{ id: "openai-codex", label: "OpenAI", models: opts.models ?? [] },
					...(opts.withOpenRouter
						? [{ id: "openrouter", label: "OpenRouter", models: [] }]
						: []),
				],
			}),
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: opts.model ?? null,
				effort: opts.effort ?? "off",
				enabled_models: opts.enabledModels ?? [],
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
		providerConfigure,
		providerTest,
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

/** From the provider LIST view, click into the OpenAI provider's detail. */
async function openProviderDetail(user: ReturnType<typeof userEvent.setup>) {
	const entry = await screen.findByRole("button", { name: /OpenAI/ });
	await user.click(entry);
}

describe("Models settings page (ADR-0024)", () => {
	it("reflects provider connection + global effort from the backend", async () => {
		const { runtime } = makeRuntime({ connected: true, effort: "high" });
		renderPage(runtime);

		// Connection status shows per-provider on the LIST view.
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

	it("shows a provider entry; drills into its detail and back", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"] },
		];
		const { runtime } = makeRuntime({ connected: true, models });
		renderPage(runtime);

		// LIST view: a clickable provider entry for "OpenAI". No model rows yet.
		const entry = await screen.findByRole("button", { name: /OpenAI/ });
		expect(entry).toBeInTheDocument();
		expect(screen.queryByRole("row", { name: /GPT-5\.5/ })).toBeNull();

		// Drill in: the DETAIL view lists that provider's models.
		await user.click(entry);
		expect(
			await screen.findByRole("row", { name: /GPT-5\.5/ }),
		).toBeInTheDocument();

		// A Back control returns to the list (provider entry visible again).
		await user.click(screen.getByRole("button", { name: /back/i }));
		expect(
			await screen.findByRole("button", { name: /OpenAI/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("row", { name: /GPT-5\.5/ })).toBeNull();
	});

	it("on a provider/status fetch FAILURE shows Not connected with NO action button (no synthesized auth kind → no bogus Connect/Configure)", async () => {
		// settings/get and model/catalog succeed (so the row renders), but
		// provider/status REJECTS. connectedById is synthesized `false` (so the row
		// leaves "Checking…" for an honest "Not connected"), but there is NO wire
		// auth_kind — so we must render NEITHER a Connect (oauth) NOR a Configure
		// (api_key) button. A defaulted "oauth" would show a bogus Connect on a
		// key-provider; the correct affordance only appears on the next SUCCESSFUL
		// status read.
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
			// provider/status REJECTS — runPromise rejects, hitting refreshConnected's
			// .catch. The error value is irrelevant (the catch ignores it).
			providerStatus: () => Effect.die("status fetch failed"),
			providerLoginStart: () =>
				Effect.succeed({ authorize_url: "https://auth.example/x" }),
			providerConfigure: die,
			providerTest: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			settingsSet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		// The row settles to an honest "Not connected" — never permanent "Checking…".
		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/not connected/i,
			),
		);
		expect(screen.getByTestId("provider-status")).not.toHaveTextContent(
			/checking/i,
		);
		// But with no wire auth_kind, NEITHER auth-specific action button renders —
		// no bogus Connect (which a defaulted "oauth" would have shown) and no
		// Configure. (Anchor the names: the row's own button name contains "connect"
		// from the status text "Not connected".)
		expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^configure$/i })).toBeNull();

		await runtime.dispose();
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
			).pipe(
				Effect.as({
					provider: "openai-codex",
					model: null,
					effort: "x",
					enabled_models: [],
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
					providers: [
						{
							id: "openai-codex",
							connected: false,
							auth_kind: "oauth" as const,
						},
					],
				}),
			providerLoginStart: die,
			providerConfigure: die,
			providerTest: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "low",
					enabled_models: [],
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

	it("lists the catalog in the provider detail and persists a preferred model via settings/set", async () => {
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

		// Preferred model lives in the provider detail — drill in first.
		await openProviderDetail(user);

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

	it("locks the current default's enable toggle; toggling a non-default off persists the materialized set minus it; choosing a new default frees the old one", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"] },
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 Mini",
				reasoning: true,
				input: ["text"],
			},
		];
		// Stored enabled set is empty (= "all enabled", slice 3 rule); default is GPT-5.5.
		const { runtime, settingsSet } = makeRuntime({
			connected: true,
			models,
			model: "gpt-5.5",
			enabledModels: [],
		});
		renderPage(runtime);

		await openProviderDetail(user);

		const defaultRow = await screen.findByRole("row", { name: /GPT-5\.5/ });
		const miniRow = await screen.findByRole("row", { name: /GPT-5\.4 Mini/ });

		// The current default (GPT-5.5) toggle is LOCKED: checked + disabled + hint.
		const defaultToggle = within(defaultRow).getByRole("checkbox", {
			name: /enabled for chat/i,
		});
		expect(defaultToggle).toBeChecked();
		expect(defaultToggle).toBeDisabled();
		expect(defaultToggle).toHaveAccessibleDescription(
			/another model as default/i,
		);

		// Toggling the non-default OFF while stored set is empty(=all) must MATERIALIZE
		// the full catalog and persist it minus the toggled-off model — never `[]`
		// (which would mean "all" again).
		await user.click(
			within(miniRow).getByRole("checkbox", { name: /enabled for chat/i }),
		);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				enabled_models: ["gpt-5.5"],
			}),
		);

		// Re-enable GPT-5.4 Mini. That makes EVERY model enabled again, so the set
		// normalizes back to the `[]` uncurated sentinel rather than persisting the
		// full materialized catalog (which would re-freeze against future growth).
		await user.click(
			within(
				await screen.findByRole("row", { name: /GPT-5\.4 Mini/ }),
			).getByRole("checkbox", { name: /enabled for chat/i }),
		);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ enabled_models: [] }),
		);

		// Now make GPT-5.4 Mini the default. With Mini enabled and chosen as
		// preferred, GPT-5.5's toggle unlocks.
		await user.click(
			within(
				await screen.findByRole("row", { name: /GPT-5\.4 Mini/ }),
			).getByRole("button", { name: /set as preferred/i }),
		);

		await waitFor(() => {
			const freed = within(
				screen.getByRole("row", { name: /GPT-5\.5/ }),
			).getByRole("checkbox", { name: /enabled for chat/i });
			expect(freed).not.toBeDisabled();
		});
		// And the new default (Mini) is now the locked one.
		expect(
			within(screen.getByRole("row", { name: /GPT-5\.4 Mini/ })).getByRole(
				"checkbox",
				{ name: /enabled for chat/i },
			),
		).toBeDisabled();
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
					enabled_models: [],
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
					providers: [
						{
							id: "openai-codex",
							connected: true,
							auth_kind: "oauth" as const,
						},
					],
				}),
			providerLoginStart: die,
			providerConfigure: die,
			providerTest: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
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

		// Preferred-model picks happen in the provider detail.
		await openProviderDetail(user);

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

describe("Models settings — key-configurable provider (ADR-0062)", () => {
	it("shows a 'Configure' affordance (not 'Connect') for OpenRouter while the OAuth codex row keeps 'Connect'", async () => {
		const { runtime } = makeRuntime({ connected: false, withOpenRouter: true });
		renderPage(runtime);

		// The disconnected OAuth provider (codex) still offers the OAuth "Connect".
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /^connect$/i }),
			).toBeInTheDocument(),
		);
		// The key-configurable provider (OpenRouter) offers "Configure" instead —
		// no OAuth "Connect" for it.
		expect(
			await screen.findByRole("button", { name: /^configure$/i }),
		).toBeInTheDocument();
	});

	it("submits the pasted key via provider/configure and flips the OpenRouter row to Connected live", async () => {
		const user = userEvent.setup();
		const { runtime, providerConfigure } = makeRuntime({
			connected: false,
			withOpenRouter: true,
		});
		renderPage(runtime);

		// Open the key-entry form.
		await user.click(
			await screen.findByRole("button", { name: /^configure$/i }),
		);

		// Paste a key and save.
		const key = "sk-or-v1-testkey";
		const input = await screen.findByLabelText(/api key/i);
		await user.type(input, key);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// provider/configure is called with the OpenRouter id + the entered key.
		await waitFor(() =>
			expect(providerConfigure).toHaveBeenCalledWith("openrouter", key),
		);

		// The row reflects Connected once the key is stored (the returned status
		// routes through the refreshConnected / setQueryData chokepoint).
		await waitFor(() => {
			const rows = screen.getAllByTestId("provider-status");
			expect(rows.some((r) => /^connected$/i.test(r.textContent ?? ""))).toBe(
				true,
			);
		});
	});

	it("a stale in-flight provider/status resolving AFTER configure does not clobber the just-configured Connected row (ADR-0049 guard)", async () => {
		const user = userEvent.setup();
		// The mount poll resolves promptly (disconnected → the Configure affordance
		// renders). A SECOND poll (a focus-return we dispatch) is GATED — it stays in
		// flight carrying PRE-configure disconnected truth. We then configure
		// OpenRouter (resolves synchronously → connected), and only AFTER release the
		// stale second poll. That out-of-order resolution is exactly what the
		// monotonic guard must absorb: without onConfigure bumping latestStatusRequest,
		// the stale resolution passes its own guard (requestId still latest) and
		// overwrites connected → disconnected (the flash ADR-0049 prevents).
		const gatedReleases: Array<() => void> = [];
		let statusCalls = 0;
		const disconnectedStatus = {
			providers: [
				{ id: "openai-codex", connected: false, auth_kind: "oauth" as const },
				{ id: "openrouter", connected: false, auth_kind: "api_key" as const },
			],
		};
		const providerStatus = vi.fn(() => {
			statusCalls += 1;
			// First call (mount) resolves immediately → rows render Configure/Connect.
			// Every later call (the focus-return) is GATED so we control when its
			// PRE-configure disconnected payload lands.
			if (statusCalls === 1) return Effect.succeed(disconnectedStatus);
			return Effect.promise(
				() => new Promise<void>((resolve) => gatedReleases.push(resolve)),
			).pipe(Effect.as(disconnectedStatus));
		});
		const providerConfigure = vi.fn((_provider: string, _apiKey: string) =>
			Effect.succeed({
				providers: [
					{ id: "openai-codex", connected: false, auth_kind: "oauth" as const },
					{ id: "openrouter", connected: true, auth_kind: "api_key" as const },
				],
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
			providerStatus,
			providerLoginStart: () =>
				Effect.succeed({ authorize_url: "https://auth.example/x" }),
			providerConfigure,
			providerTest: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", label: "OpenAI", models: [] },
						{ id: "openrouter", label: "OpenRouter", models: [] },
					],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			settingsSet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		// Mount poll landed disconnected → the Configure affordance is present.
		const configureBtn = await screen.findByRole("button", {
			name: /^configure$/i,
		});

		// Dispatch a focus-return: issues a SECOND provider/status poll that we've
		// gated. It's now in flight carrying pre-configure disconnected truth.
		window.dispatchEvent(new Event("focus"));
		await waitFor(() => expect(gatedReleases.length).toBeGreaterThanOrEqual(1));

		// Configure OpenRouter: paste a key + save. configure resolves synchronously
		// and writes connected:true through applyStatus (which now bumps the guard).
		await user.click(configureBtn);
		await user.type(await screen.findByLabelText(/api key/i), "sk-or-v1-key");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() =>
			expect(providerConfigure).toHaveBeenCalledWith(
				"openrouter",
				"sk-or-v1-key",
			),
		);

		// The OpenRouter row is now Connected.
		await waitFor(() => {
			const rows = screen.getAllByTestId("provider-status");
			expect(rows.some((r) => /^connected$/i.test(r.textContent ?? ""))).toBe(
				true,
			);
		});

		// NOW release the STALE focus poll(s) (pre-configure: OpenRouter disconnected).
		// onConfigure must have bumped latestStatusRequest, so each resolution's
		// requestId is no longer latest → it's dropped. The row STAYS Connected.
		for (const release of gatedReleases) release();

		// Give the stale resolution ample chance to (wrongly) land, then assert it
		// didn't clobber the connected row.
		await waitFor(() => {
			const rows = screen.getAllByTestId("provider-status");
			expect(rows.some((r) => /^connected$/i.test(r.textContent ?? ""))).toBe(
				true,
			);
		});
		// Flush microtasks and re-assert: the row is still Connected (no flash back).
		await Promise.resolve();
		const finalRows = screen.getAllByTestId("provider-status");
		expect(
			finalRows.some((r) => /^connected$/i.test(r.textContent ?? "")),
		).toBe(true);

		await runtime.dispose();
	});

	it("surfaces a provider/configure error without crashing", async () => {
		const user = userEvent.setup();
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
					providers: [
						{
							id: "openai-codex",
							connected: false,
							auth_kind: "oauth" as const,
						},
						{
							id: "openrouter",
							connected: false,
							auth_kind: "api_key" as const,
						},
					],
				}),
			providerLoginStart: die,
			// provider/configure REJECTS (e.g. Core rejected the key) — the form must
			// surface the failure, not blow up the page.
			providerConfigure: () => Effect.die("configure failed"),
			providerTest: () => Effect.die("configure failed"),
			modelCatalog: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", label: "OpenAI", models: [] },
						{ id: "openrouter", label: "OpenRouter", models: [] },
					],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			settingsSet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		await user.click(
			await screen.findByRole("button", { name: /^configure$/i }),
		);
		await user.type(await screen.findByLabelText(/api key/i), "sk-bad");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// An error is shown; the OpenRouter row stays Not connected (never crashes).
		expect(
			await screen.findByText(/couldn't|could not|failed/i),
		).toBeInTheDocument();

		await runtime.dispose();
	});
});

describe("Models settings — provider liveness Test (ADR-0062)", () => {
	// A runtime whose OpenRouter provider carries real catalog models (so its
	// detail has something to probe) and whose provider/test resolves to a verdict
	// the test controls. Both providers are connected so the detail renders.
	function makeTestRuntime(verdict: { alive: boolean; message?: string }) {
		const orModels: ModelInfo[] = [
			{
				id: "openrouter/auto",
				name: "Auto",
				reasoning: false,
				input: ["text"],
			},
		];
		const providerTest = vi.fn((_provider: string, _model: string) =>
			Effect.succeed(verdict),
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
					providers: [
						{
							id: "openai-codex",
							connected: true,
							auth_kind: "oauth" as const,
						},
						{
							id: "openrouter",
							connected: true,
							auth_kind: "api_key" as const,
						},
					],
				}),
			providerLoginStart: () =>
				Effect.succeed({ authorize_url: "https://auth.example/x" }),
			providerConfigure: die,
			providerTest,
			modelCatalog: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", label: "OpenAI", models: [] },
						{ id: "openrouter", label: "OpenRouter", models: orModels },
					],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			settingsSet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
					enabled_models: [],
				}),
			proposalGet: die,
			rescanJournalEntry: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		return {
			runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
			providerTest,
		};
	}

	/** Drill into the OpenRouter provider detail from the LIST view. */
	async function openOpenRouterDetail(
		user: ReturnType<typeof userEvent.setup>,
	) {
		await user.click(
			await screen.findByRole("button", { name: /Open OpenRouter models/i }),
		);
	}

	it("clicking Test probes provider/test with (openrouter, one of its models) and shows an alive indicator on {alive:true}", async () => {
		const user = userEvent.setup();
		const { runtime, providerTest } = makeTestRuntime({ alive: true });
		renderPage(runtime);

		await openOpenRouterDetail(user);

		await user.click(await screen.findByRole("button", { name: /^test$/i }));

		// Probes with the OpenRouter id + a model belonging to that provider.
		await waitFor(() =>
			expect(providerTest).toHaveBeenCalledWith(
				"openrouter",
				"openrouter/auto",
			),
		);

		// A positive/working liveness indicator renders.
		expect(await screen.findByText(/working/i)).toBeInTheDocument();

		await runtime.dispose();
	});

	it("shows a dead indicator with the failure message on {alive:false, message}", async () => {
		const user = userEvent.setup();
		const { runtime, providerTest } = makeTestRuntime({
			alive: false,
			message: "401 unauthorized",
		});
		renderPage(runtime);

		await openOpenRouterDetail(user);
		await user.click(await screen.findByRole("button", { name: /^test$/i }));

		await waitFor(() => expect(providerTest).toHaveBeenCalledTimes(1));

		// The dead verdict surfaces the failure message.
		expect(await screen.findByText(/401 unauthorized/i)).toBeInTheDocument();

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
			providers: [
				{ id: "openai-codex", connected, auth_kind: "oauth" as const },
			],
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
		providerConfigure: die,
		providerTest: die,
		modelCatalog: () =>
			Effect.succeed({
				providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
			}),
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: null,
				effort: "off",
				enabled_models: [],
			}),
		settingsSet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: null,
				effort: "off",
				enabled_models: [],
			}),
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

	// renderPage builds its own internal QueryClient (renderWithQuery, no
	// injection seam), so wrap with a test-owned client here to read/spy the
	// ["provider-status"] cache — the chat gate (connect welcome + composer
	// soft-disable) reads it via useProviderStatus.
	function renderPageWithClient(
		runtime: ReturnType<typeof makeFlippingRuntime>,
		client: QueryClient,
	) {
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
		});
		render(
			<QueryClientProvider client={client}>
				<RuntimeProvider runtime={runtime}>
					<RouterProvider router={router} />
				</RuntimeProvider>
			</QueryClientProvider>,
		);
	}

	it("writes connected into the ['provider-status'] cache on the live push, so a remounting chat gate reads the truth (no stale-cache flash)", async () => {
		// Capture the page's "provider/connected" closure via the SDK seam.
		let pushed: ((params: unknown) => void) | undefined;
		const spy = vi
			.spyOn(sdk, "setNotificationHandler")
			.mockImplementation((method, handler) => {
				if (method === "provider/connected") pushed = handler;
			});

		try {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			// Pre-seed the cache as a prior disconnected `/` visit would have: the
			// chat query is now INACTIVE (the user navigated here to /settings), so
			// invalidateQueries (type:"active" by default) would NOT refetch it — only
			// setQueryData keeps it truthful for the chat column's remount. This is the
			// regression guard for the cross-engine-caught stale-cache flash.
			client.setQueryData<ProviderStatusResult>(["provider-status"], {
				providers: [
					{ id: "openai-codex", connected: false, auth_kind: "oauth" as const },
				],
			});

			const runtime = makeFlippingRuntime();
			renderPageWithClient(runtime, client);

			// Let mount settle: the card first reports Not connected.
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

			// Fire the push: the flipping runtime now reports connected, so the page
			// must write connected:true into the shared cache (not just mark it stale).
			pushed({ provider: "openai-codex" });

			await waitFor(() => {
				const cached = client.getQueryData<ProviderStatusResult>([
					"provider-status",
				]);
				expect(cached?.providers.some((p) => p.connected)).toBe(true);
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("writes the FULL provider/status payload, not a single-provider snapshot (preserves other providers)", async () => {
		// CodeRabbit caught this: useProviderStatus derives anyConnected across ALL
		// providers[], so refreshConnected must cache the whole provider/status
		// result — not a synthesized openai-codex-only row that would drop other
		// providers from the shared cache. The runtime reports TWO providers; the
		// write must keep both.
		let pushed: ((params: unknown) => void) | undefined;
		const spy = vi
			.spyOn(sdk, "setNotificationHandler")
			.mockImplementation((method, handler) => {
				if (method === "provider/connected") pushed = handler;
			});

		try {
			const twoProviderStatus: ProviderStatusResult = {
				providers: [
					{ id: "openai-codex", connected: true, auth_kind: "oauth" as const },
					{ id: "anthropic", connected: true, auth_kind: "oauth" as const },
				],
			};
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
				providerStatus: () => Effect.succeed(twoProviderStatus),
				providerLoginStart: () =>
					Effect.succeed({ authorize_url: "https://auth.example/x" }),
				providerConfigure: die,
				providerTest: die,
				modelCatalog: () =>
					Effect.succeed({
						providers: [{ id: "openai-codex", label: "OpenAI", models: [] }],
					}),
				settingsGet: () =>
					Effect.succeed({
						provider: "openai-codex",
						model: null,
						effort: "off",
						enabled_models: [],
					}),
				settingsSet: () =>
					Effect.succeed({
						provider: "openai-codex",
						model: null,
						effort: "off",
						enabled_models: [],
					}),
				proposalGet: die,
				rescanJournalEntry: die,
				proposalDecide: die,
				messageSearch: die,
				proposalNotifications: () => Stream.empty,
				connectionStatus: () => Stream.empty,
			});
			const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			renderPageWithClient(
				runtime as unknown as ReturnType<typeof makeFlippingRuntime>,
				client,
			);

			if (pushed === undefined) {
				await waitFor(() => expect(pushed).toBeDefined());
			}
			pushed?.({ provider: "openai-codex" });

			await waitFor(() => {
				const cached = client.getQueryData<ProviderStatusResult>([
					"provider-status",
				]);
				// BOTH providers survive — not clobbered down to the openai-codex row.
				expect(cached?.providers.map((p) => p.id).sort()).toEqual([
					"anthropic",
					"openai-codex",
				]);
			});

			await runtime.dispose();
		} finally {
			spy.mockRestore();
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
