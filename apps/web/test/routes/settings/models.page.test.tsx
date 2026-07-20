import type { ModelInfo, ProviderStatusResult } from "@inkstone/protocol";
import type { WsClientService } from "@inkstone/ui-sdk";
import { ProviderLoginFailedError, WsRequestError } from "@inkstone/ui-sdk";
import type { QueryClient } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	makeQueryClient,
	renderWithCore,
} from "@test/test-utils/renderWithCore";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";

afterEach(() => {
	cleanup();
});

function makeOverrides(opts: {
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
	// Replaces the default always-succeeding provider/login_start stub — tests
	// exercising a failed Connect inject the typed failure here.
	loginStart?: WsClientService["providerLoginStart"];
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
	const overrides: Partial<WsClientService> = {
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
		providerLoginStart:
			opts.loginStart ??
			(() => Effect.succeed({ authorize_url: "https://auth.example/x" })),
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
	};
	return {
		overrides,
		settingsSet,
		providerConfigure,
		providerTest,
	};
}

// The four stub stanzas every inline-override test declares identically: a
// succeeding login start, a bare single-provider catalog, and default (unset)
// settings. providerStatus is deliberately ABSENT — tests stub it per-site,
// and the status-fetch-FAILURE test relies on stubWsClient's loud Effect.die
// default for the un-stubbed verb. Members are plain arrows (never vi.fn())
// so call counts can't leak across tests.
const BASE_OVERRIDES: Partial<WsClientService> = {
	providerLoginStart: () =>
		Effect.succeed({ authorize_url: "https://auth.example/x" }),
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
};

function renderPage(overrides: Partial<WsClientService>) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
	});
	return renderWithCore(<RouterProvider router={router} />, { overrides });
}

/** From the provider LIST view, click into the OpenAI provider's detail. */
async function openProviderDetail(user: ReturnType<typeof userEvent.setup>) {
	const entry = await screen.findByRole("button", { name: /OpenAI/ });
	await user.click(entry);
}

describe("Models settings page (ADR-0024)", () => {
	it("reflects provider connection + global effort from the backend", async () => {
		const { overrides } = makeOverrides({ connected: true, effort: "high" });
		await renderPage(overrides);

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
		const { overrides } = makeOverrides({ connected: true, models });
		await renderPage(overrides);

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

	it("on a provider/status fetch FAILURE shows Not connected with NO action button but DOES surface a 'couldn't check' banner + retry (no silent strand)", async () => {
		// settings/get and model/catalog succeed (so the row renders), but
		// provider/status REJECTS. The failed statusView derives every row to "Not
		// connected" (never a permanent "Checking…"), but there is NO wire
		// auth_kind — so we must render NEITHER a Connect (oauth) NOR a Configure
		// (api_key) button. A defaulted "oauth" would show a bogus Connect on a
		// key-provider; the correct affordance only appears on the next SUCCESSFUL
		// status read. Because that buttonless "Not connected" row is indistinct from
		// a genuine disconnect, the section ALSO raises a "couldn't check connections"
		// banner + a Try-again retry rather than silently stranding the user.
		// provider/status REJECTS (the factory default `Effect.die` for an un-stubbed
		// verb) — runPromise rejects, hitting refreshConnected's .catch. The error
		// value is irrelevant (the catch ignores it).
		const overrides: Partial<WsClientService> = { ...BASE_OVERRIDES };
		await renderPage(overrides);

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

		// And the user is NOT silently stranded: a "couldn't check connections"
		// banner + a Try-again retry surface the read failure (the retry re-runs
		// refreshConnected, which clears the banner on its own success).
		expect(
			screen.getByText(/couldn't check provider connections/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /try again/i }),
		).toBeInTheDocument();
	});

	it("clears a STALE auth kind on a later status failure: a prior success's Connect button does not linger beside the failure banner", async () => {
		// First status read SUCCEEDS (populates auth_kind → Connect renders), then a
		// focus-refetch REJECTS. The catch must clear authKindById, or the stale
		// "oauth" would keep painting a Connect button the failed read can no longer
		// vouch for — the second-visit variant of the buttonless-on-failure rule.
		let shouldFail = false;
		const providerStatus = vi.fn(() =>
			shouldFail
				? Effect.die("provider/status unreachable")
				: Effect.succeed({
						providers: [
							{
								id: "openai-codex",
								connected: false,
								auth_kind: "oauth" as const,
							},
						],
					}),
		);
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
			providerStatus,
		};
		await renderPage(overrides);

		// First read succeeded → the real oauth Connect affordance is present.
		expect(
			await screen.findByRole("button", { name: /^connect$/i }),
		).toBeInTheDocument();

		// Now a focus-refetch fails.
		shouldFail = true;
		window.dispatchEvent(new Event("focus"));

		// The failure banner appears AND the stale Connect button is gone (authKind
		// was cleared — a lingering button would be a lie the failed read can't back).
		await waitFor(() =>
			expect(
				screen.getByText(/couldn't check provider connections/i),
			).toBeInTheDocument(),
		);
		expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
	});

	it("recovers from a provider/status failure: 'Try again' re-reads status, clears the banner, and reveals the real Connect affordance", async () => {
		const user = userEvent.setup();
		// provider/status REJECTS until we flip `shouldFail` right before the retry
		// click, then SUCCEEDS — modelling a transient unreachable-Core that recovers.
		// Gated on a boolean (not a call count) because the catalog landing re-fires
		// refreshConnected (loadCatalog's success repoll), so several polls fire
		// before any user interaction; ALL of them must fail so the banner is stable
		// to click. The success payload carries the codex auth_kind, so the retry both
		// clears the banner and lets the correct Connect (oauth) affordance appear.
		let shouldFail = true;
		const providerStatus = vi.fn(() =>
			shouldFail
				? Effect.die("provider/status unreachable")
				: Effect.succeed({
						providers: [
							{
								id: "openai-codex",
								connected: false,
								auth_kind: "oauth" as const,
							},
						],
					}),
		);
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
			providerStatus,
		};
		await renderPage(overrides);

		// Mount poll failed → banner + retry, no action button yet.
		const retry = await screen.findByRole("button", { name: /try again/i });
		expect(
			screen.getByText(/couldn't check provider connections/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();

		// Let status reads succeed from here, then retry: the read now resolves, so
		// the banner clears and the real oauth Connect affordance renders.
		shouldFail = false;
		await user.click(retry);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /^connect$/i }),
			).toBeInTheDocument(),
		);
		expect(
			screen.queryByText(/couldn't check provider connections/i),
		).toBeNull();
	});

	it("repolls provider/status when the catalog lands — even a valid EMPTY catalog — with no user interaction (2 polls per mount)", async () => {
		// The catalog resolving is the "Core is reachable" signal that re-fires the
		// status poll (the transient-failure self-heal seam). An empty providers
		// list is still a SUCCESSFUL catalog read, so the repoll must not be gated
		// on non-emptiness; deleting the repoll (or re-gating it on
		// `providers.length > 0`) drops this to a single mount poll.
		const providerStatus = vi.fn(() =>
			Effect.succeed({
				providers: [
					{ id: "openai-codex", connected: false, auth_kind: "oauth" as const },
				],
			}),
		);
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
			providerStatus,
			modelCatalog: () => Effect.succeed({ providers: [] }),
		};
		await renderPage(overrides);

		// Mount poll + catalog-landing repoll — no focus, push, or retry fired.
		await waitFor(() => expect(providerStatus).toHaveBeenCalledTimes(2));
	});

	it("self-heals a TRANSIENT provider/status failure automatically: the catalog-landing repoll clears the banner with NO user interaction", async () => {
		// The mount poll REJECTS (a transient blip); the repoll the catalog landing
		// triggers SUCCEEDS. No Try-again click, no focus-return, no push — the
		// recovery must be automatic, or the user is stuck on the "couldn't check"
		// banner until a focus-return happens to fire.
		let statusCalls = 0;
		const providerStatus = vi.fn(() => {
			statusCalls += 1;
			return statusCalls === 1
				? Effect.die("provider/status unreachable")
				: Effect.succeed({
						providers: [
							{
								id: "openai-codex",
								connected: true,
								auth_kind: "oauth" as const,
							},
						],
					});
		});
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
			providerStatus,
		};
		await renderPage(overrides);

		// The catalog-triggered second poll heals the row to the real status…
		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/^connected$/i,
			),
		);
		// …and the "couldn't check" banner is gone — all without any interaction.
		expect(
			screen.queryByText(/couldn't check provider connections/i),
		).toBeNull();
		expect(providerStatus).toHaveBeenCalledTimes(2);
	});

	it("persists an effort change via settings/set", async () => {
		const user = userEvent.setup();
		const { overrides, settingsSet } = makeOverrides({
			connected: false,
			effort: "off",
		});
		await renderPage(overrides);

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
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
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
			// Persisted effort starts "low" — backs the rollback-target assertion.
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "low",
					enabled_models: [],
				}),
			settingsSet,
		};
		await renderPage(overrides);

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
		const { overrides, settingsSet } = makeOverrides({
			connected: true,
			models,
		});
		await renderPage(overrides);

		// Preferred model lives in the provider detail — drill in first.
		await openProviderDetail(user);

		const row = await screen.findByRole("row", { name: /GPT-5\.5/ });
		// Both bare-named models group under one "OpenAI" vendor rowgroup header,
		// so the table has 1 header row + 2 model rows.
		expect(
			screen.getByRole("rowheader", { name: "OpenAI" }),
		).toBeInTheDocument();
		expect(screen.getAllByRole("row")).toHaveLength(3);

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
		const { overrides, settingsSet } = makeOverrides({
			connected: true,
			models,
			model: "gpt-5.5",
			enabledModels: [],
		});
		await renderPage(overrides);

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
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
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
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models }],
				}),
			settingsSet,
		};
		await renderPage(overrides);

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
	});
});

describe("Models settings — failed Connect surfaces Core's reason", () => {
	it("renders a ProviderLoginFailedError's sanitized message verbatim in the status line", async () => {
		const user = userEvent.setup();
		// provider/login_start fails TYPED (-32003 → ProviderLoginFailedError):
		// Core's sanitized reason must reach the status line verbatim, not be
		// flattened into the generic couldn't-start copy.
		const { overrides } = makeOverrides({
			connected: false,
			loginStart: () =>
				Effect.fail(
					new ProviderLoginFailedError({
						message: "a provider login is already in progress",
					}),
				),
		});
		await renderPage(overrides);

		await user.click(await screen.findByRole("button", { name: /^connect$/i }));

		const status = await screen.findByRole("status");
		await waitFor(() =>
			expect(status).toHaveTextContent(
				"a provider login is already in progress",
			),
		);
		expect(status.textContent).toBe("a provider login is already in progress");
	});

	it("keeps the generic couldn't-start copy for a non-login-failed error", async () => {
		const user = userEvent.setup();
		// A transport-level failure (no -32003 envelope) has no sanitized reason
		// to show — the generic copy stays.
		const { overrides } = makeOverrides({
			connected: false,
			loginStart: () =>
				Effect.fail(new WsRequestError({ reason: "send_failed" })),
		});
		await renderPage(overrides);

		await user.click(await screen.findByRole("button", { name: /^connect$/i }));

		const status = await screen.findByRole("status");
		await waitFor(() =>
			expect(status).toHaveTextContent(
				"Couldn't start the connection. Try Connect again.",
			),
		);
	});

	it("falls back to the generic copy for a ProviderLoginFailedError with an empty message", async () => {
		const user = userEvent.setup();
		// Core never emits an empty -32003 message today, but an empty string
		// would render a blank status line — the guard downgrades it.
		const { overrides } = makeOverrides({
			connected: false,
			loginStart: () =>
				Effect.fail(new ProviderLoginFailedError({ message: "" })),
		});
		await renderPage(overrides);

		await user.click(await screen.findByRole("button", { name: /^connect$/i }));

		const status = await screen.findByRole("status");
		await waitFor(() =>
			expect(status).toHaveTextContent(
				"Couldn't start the connection. Try Connect again.",
			),
		);
	});
});

describe("Models settings — key-configurable provider (ADR-0062)", () => {
	it("shows a 'Configure' affordance (not 'Connect') for OpenRouter while the OAuth codex row keeps 'Connect'", async () => {
		const { overrides } = makeOverrides({
			connected: false,
			withOpenRouter: true,
		});
		await renderPage(overrides);

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
		const { overrides, providerConfigure } = makeOverrides({
			connected: false,
			withOpenRouter: true,
		});
		await renderPage(overrides);

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
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
			providerStatus,
			providerConfigure,
			modelCatalog: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", label: "OpenAI", models: [] },
						{ id: "openrouter", label: "OpenRouter", models: [] },
					],
				}),
		};
		await renderPage(overrides);

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
	});

	it("surfaces a provider/configure error without crashing", async () => {
		const user = userEvent.setup();
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
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
		};
		await renderPage(overrides);

		await user.click(
			await screen.findByRole("button", { name: /^configure$/i }),
		);
		await user.type(await screen.findByLabelText(/api key/i), "sk-bad");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		// An error is shown; the OpenRouter row stays Not connected (never crashes).
		expect(
			await screen.findByText(/couldn't|could not|failed/i),
		).toBeInTheDocument();
	});
});

describe("Models settings — provider liveness Test (ADR-0062)", () => {
	// Stub verbs whose OpenRouter provider carries real catalog models (so its
	// detail has something to probe) and whose provider/test resolves to a verdict
	// the test controls. Both providers are connected so the detail renders.
	function makeTestOverrides(verdict: { alive: boolean; message?: string }) {
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
		const overrides: Partial<WsClientService> = {
			...BASE_OVERRIDES,
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
			providerTest,
			modelCatalog: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", label: "OpenAI", models: [] },
						{ id: "openrouter", label: "OpenRouter", models: orModels },
					],
				}),
		};
		return {
			overrides,
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
		const { overrides, providerTest } = makeTestOverrides({ alive: true });
		await renderPage(overrides);

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
	});

	it("shows a dead indicator with the failure message on {alive:false, message}", async () => {
		const user = userEvent.setup();
		const { overrides, providerTest } = makeTestOverrides({
			alive: false,
			message: "401 unauthorized",
		});
		await renderPage(overrides);

		await openOpenRouterDetail(user);
		await user.click(await screen.findByRole("button", { name: /^test$/i }));

		await waitFor(() => expect(providerTest).toHaveBeenCalledTimes(1));

		// The dead verdict surfaces the failure message.
		expect(await screen.findByText(/401 unauthorized/i)).toBeInTheDocument();
	});
});

// Stub verbs whose `provider/status` flips false → true across calls: the first
// poll is "Not connected", every poll after a (re)fetch reports "Connected".
// Models the credential write that lands between the first mount-poll and the
// refetch the live push (or focus) triggers.
function makeFlippingOverrides(): Partial<WsClientService> {
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
	return { ...BASE_OVERRIDES, providerStatus };
}

describe("Models settings page — provider/connected live push (ADR-0049)", () => {
	// Drive the `provider/connected` push through the SDK's `notifications` stream
	// (ADR-0047 amendment): a test-owned unbounded queue backs the stubbed member,
	// so `push()` offers a decoded frame exactly as the live PubSub would deliver
	// one. Unbounded → offering before the mount subscribe still delivers (no
	// race). Returns the overrides to spread + a `push` fn to fire after mount.
	function makeConnectedPush(base: Partial<WsClientService>): {
		overrides: Partial<WsClientService>;
		push: () => void;
	} {
		const queue = Effect.runSync(Queue.unbounded<unknown>());
		return {
			overrides: {
				...base,
				// The stub bypasses the SDK's schema decode — the test owns the payload
				// it offers. Key by method so this only drives `provider/connected`: the
				// mounted routeTree also subscribes `thread/titled` at the root, and a
				// method-blind shared queue would make the two subscribers contend
				// (Queue = one taker per item) instead of the live per-method PubSub
				// broadcast. Other methods get an empty stream.
				notifications: ((method: string) =>
					method === "provider/connected"
						? Stream.fromQueue(queue)
						: Stream.empty) as WsClientService["notifications"],
			},
			push: () =>
				Effect.runSync(Queue.offer(queue, { provider: "openai-codex" })),
		};
	}

	it("flips the card to Connected from the live push alone — no window 'focus'", async () => {
		// Watch every window 'focus' dispatch — the verdict-critical assertion is
		// that the push path NEVER relies on one.
		const focusSpy = vi.fn();
		window.addEventListener("focus", focusSpy);

		try {
			const { overrides, push } = makeConnectedPush(makeFlippingOverrides());
			await renderPage(overrides);

			// First poll (mount) reports Not connected.
			await waitFor(() =>
				expect(screen.getByTestId("provider-status")).toHaveTextContent(
					/not connected/i,
				),
			);

			// Fire the push (params ignored by the consumer) — this alone must
			// trigger a refetch that flips the card.
			push();

			await waitFor(() =>
				expect(screen.getByTestId("provider-status")).toHaveTextContent(
					/^connected$/i,
				),
			);

			// No focus event was dispatched anywhere on the push path.
			expect(focusSpy).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("focus", focusSpy);
		}
	});

	// Inject a test-owned client (the harness's queryClient seam) to read/spy the
	// ["provider-status"] cache — the chat gate (connect welcome + composer
	// soft-disable) reads it via useProviderStatus.
	function renderPageWithClient(
		overrides: Partial<WsClientService>,
		client: QueryClient,
	) {
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
		});
		return renderWithCore(<RouterProvider router={router} />, {
			overrides,
			queryClient: client,
		});
	}

	it("writes connected into the ['provider-status'] cache on the live push, so a remounting chat gate reads the truth (no stale-cache flash)", async () => {
		const client = makeQueryClient();
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

		const { overrides, push } = makeConnectedPush(makeFlippingOverrides());
		await renderPageWithClient(overrides, client);

		// Let mount settle: the card first reports Not connected.
		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/not connected/i,
			),
		);

		// Fire the push: the flipping runtime now reports connected, so the page
		// must write connected:true into the shared cache (not just mark it stale).
		push();

		await waitFor(() => {
			const cached = client.getQueryData<ProviderStatusResult>([
				"provider-status",
			]);
			expect(cached?.providers.some((p) => p.connected)).toBe(true);
		});
	});

	it("writes the FULL provider/status payload, not a single-provider snapshot (preserves other providers)", async () => {
		// CodeRabbit caught this: useProviderStatus derives anyConnected across ALL
		// providers[], so refreshConnected must cache the whole provider/status
		// result — not a synthesized openai-codex-only row that would drop other
		// providers from the shared cache. The runtime reports TWO providers; the
		// write must keep both.
		//
		// The FULL two-provider payload is exposed ONLY on the post-push refetch: the
		// mount poll returns a single-provider snapshot, so the two-provider assertion
		// can pass ONLY if the push actually drove a refresh (guards against the test
		// passing off the mount poll alone, which would make `push()` incidental).
		let calls = 0;
		const { overrides, push } = makeConnectedPush({
			...BASE_OVERRIDES,
			providerStatus: () => {
				calls += 1;
				return Effect.succeed(
					calls === 1
						? {
								providers: [
									{
										id: "openai-codex",
										connected: false,
										auth_kind: "oauth" as const,
									},
								],
							}
						: {
								providers: [
									{
										id: "openai-codex",
										connected: true,
										auth_kind: "oauth" as const,
									},
									{
										id: "anthropic",
										connected: true,
										auth_kind: "oauth" as const,
									},
								],
							},
				);
			},
		});
		const client = makeQueryClient();
		await renderPageWithClient(overrides, client);

		// Mount settles on the single-provider snapshot first.
		await waitFor(() => {
			const cached = client.getQueryData<ProviderStatusResult>([
				"provider-status",
			]);
			expect(cached?.providers.map((p) => p.id)).toEqual(["openai-codex"]);
		});

		push();

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
	});

	it("focus-refetch fallback flips the card in isolation — no push fired", async () => {
		// Regression lock for the existing focus-refetch safety net (ADR-0023),
		// proven independent of the live push: never fire the handler.
		const overrides = makeFlippingOverrides();
		await renderPage(overrides);

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
