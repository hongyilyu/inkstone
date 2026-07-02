import type {
	ProviderAuthKind,
	ProviderModels,
	ProviderStatusResult,
} from "@inkstone/protocol";
import {
	clearNotificationHandler,
	setNotificationHandler,
} from "@inkstone/ui-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EffortControl } from "@/components/EffortControl";
import { ProviderConfigureForm } from "@/components/ProviderConfigureForm";
import { ProviderModelsDetail } from "@/components/ProviderModelsDetail";
import { Button } from "@/components/ui/button";
import {
	type SaveStatus,
	useOptimisticSetting,
} from "@/lib/hooks/useOptimisticSetting";
import { cn } from "@/lib/utils";
import { useRuntime } from "@/runtime";
import {
	configure,
	fetchProviderStatus,
	startLogin,
	test as testProvider,
} from "@/store/providers";
import { fetchCatalog, fetchSettings, saveSettings } from "@/store/settings";

/** `/settings/models` (ADR-0024): a provider master/detail. The LIST view shows one row per `model/catalog` provider group (label, connection status, model count) plus the global effort control; clicking a provider opens its DETAIL view — that provider's models with the Preferred affordance. Persisted via `settings/*`, read from `model/catalog`. */
function ModelsSettings() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	// Connection state keyed by provider id (null while the first status query is
	// in flight). Drives every provider row's status without resynthesis.
	const [connectedById, setConnectedById] = useState<Record<
		string,
		boolean
	> | null>(null);
	// Each provider's auth kind (ADR-0062), read off the same provider/status
	// payload. Drives the Connect (oauth) vs Configure (api_key) affordance — the
	// wire carries it, so the Web never guesses "not-codex = key".
	const [authKindById, setAuthKindById] = useState<
		Record<string, ProviderAuthKind>
	>({});
	// Latest in-flight provider/status request — guards refreshConnected's writes
	// against out-of-order resolution (see the useCallback below).
	const latestStatusRequest = useRef(0);
	// Monotonic token for catalog loads (mount effect + retry button share one
	// path). Guards the same way latestStatusRequest does: a superseded or
	// post-unmount response must not overwrite newer state.
	const latestCatalogRequest = useRef(0);
	const [busy, setBusy] = useState(false);
	const [providers, setProviders] = useState<readonly ProviderModels[]>([]);
	// Whether the model catalog read failed. Distinguishes a genuine empty catalog
	// from an unreachable Core so the Providers section shows an honest error + a
	// retry instead of a blank list of dead-clickable rows.
	const [catalogFailed, setCatalogFailed] = useState(false);
	// Whether the provider/status read failed. Distinguishes "couldn't reach Core to
	// CHECK connection" from a genuine all-disconnected state — the catch below
	// synthesizes `connected: false` (so rows stay readable) but that reads exactly
	// like a real disconnect. This flag raises an honest "couldn't check" banner +
	// retry so the user is never silently stranded (mirrors `catalogFailed`).
	const [statusFailed, setStatusFailed] = useState(false);
	// Master/detail: null = provider list, otherwise the focused provider's id.
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	// Whether a provider login failed to start (surfaced in the shared status line).
	const [connectFailed, setConnectFailed] = useState(false);
	// The key-provider id whose inline Configure form is open (null = none).
	const [configuringId, setConfiguringId] = useState<string | null>(null);

	// Effort + preferred model are optimistic, latest-write-wins, roll back to the
	// last confirmed value (see useOptimisticSetting — closes the rapid-click races).
	const effort = useOptimisticSetting<string>(
		"off",
		useCallback(
			(next) => saveSettings(runtime, { effort: next }).then((s) => s.effort),
			[runtime],
		),
	);
	const model = useOptimisticSetting<string | null>(
		null,
		useCallback(
			(next) =>
				saveSettings(runtime, { model: next ?? undefined }).then(
					(s) => s.model,
				),
			[runtime],
		),
	);
	// The curated enabled set. `null` until settings/get seeds it — so the detail
	// can distinguish "not loaded yet" from "uncurated = all enabled" ([]) and never
	// flashes wrong toggle/lock state or writes off the sentinel before load. Once
	// loaded, empty = "no curation → all enabled" (ADR-0024). Same
	// optimistic/latest-write-wins/rollback machinery as model + effort.
	const enabledModels = useOptimisticSetting<readonly string[] | null>(
		null,
		useCallback(
			(next) =>
				saveSettings(runtime, { enabled_models: next ?? [] }).then(
					(s) => s.enabled_models,
				),
			[runtime],
		),
	);

	// One shared acknowledgement line for the section: error wins over saved.
	const saveStatus: SaveStatus = connectFailed
		? "error"
		: effort.status === "error" ||
				model.status === "error" ||
				enabledModels.status === "error"
			? "error"
			: effort.status === "saved" ||
					model.status === "saved" ||
					enabledModels.status === "saved"
				? "saved"
				: "idle";

	// The shared live-refresh chokepoint (ADR-0049): commit a freshly-read
	// provider/status into BOTH the per-row map and the ["provider-status"] cache
	// the chat gate reads. refreshConnected (mount/focus/push) and the configure
	// success path both route through this, so a stored key flips the row exactly
	// like a login does — no reload.
	const applyStatus = useCallback(
		(status: ProviderStatusResult) => {
			setConnectedById(
				Object.fromEntries(status.providers.map((p) => [p.id, p.connected])),
			);
			setAuthKindById(
				Object.fromEntries(status.providers.map((p) => [p.id, p.auth_kind])),
			);
			queryClient.setQueryData<ProviderStatusResult>(
				["provider-status"],
				status,
			);
		},
		[queryClient],
	);

	const refreshConnected = useCallback(() => {
		// Monotonic request id: mount, focus, AND the `provider/connected` push all
		// call this, so two provider/status round-trips can be in flight at once and
		// resolve out of order. Without a guard a stale earlier resolution could land
		// last and overwrite the shared ["provider-status"] cache (below) back to a
		// wrong value — recreating the very flash this write exists to prevent. Only
		// the latest request commits its result.
		const requestId = ++latestStatusRequest.current;
		// Read the FULL provider/status payload: the shared cache is the chat gate's
		// source of truth and useProviderStatus derives `anyConnected` across ALL
		// providers[], so writing a synthesized single-row snapshot would drop any
		// other connected provider. Derive every row's flag from the same payload —
		// one round-trip, no resynthesis.
		fetchProviderStatus(runtime)
			.then((status) => {
				if (requestId !== latestStatusRequest.current) return;
				// Write the freshly-read truth into both the per-row map and the shared
				// ["provider-status"] cache the chat gate (connect welcome + composer
				// soft-disable) reads via useProviderStatus. applyStatus is the single
				// chokepoint — mount, focus, the `provider/connected` push, AND a
				// configure success all route through it.
				//
				// setQueryData, NOT invalidateQueries: invalidate defaults to
				// type:"active", so while the chat column is unmounted (the user is over
				// here in /settings), the inactive chat query is only marked stale, not
				// refetched — it would still hold the OLD disconnected value. On returning
				// to chat, refetchOnMount serves that stale `success` data synchronously
				// before the refetch lands, flashing the connect screen at a now-connected
				// user. Writing the value keeps the cache truthful for that remount AND
				// notifies a still-mounted chat observer immediately (no refetch needed).
				applyStatus(status);
				// A read that succeeds clears any prior failure banner (mirror of
				// loadCatalog clearing catalogFailed only on success).
				setStatusFailed(false);
			})
			.catch(() => {
				if (requestId !== latestStatusRequest.current) return;
				// Status fetch failed: resolve each loaded-catalog provider id to
				// `connected: false` so rows read an honest "Not connected" instead of a
				// permanent "Checking…" (which an empty map produced, since every id then
				// resolved to null). This path carries NO wire `auth_kind` (that's only
				// populated by applyStatus on a successful read), so the rows render with
				// no Connect/Configure button — a synthesized "oauth" would show a bogus
				// Connect on a key-provider. That leaves the rows silently indistinct from
				// a genuine disconnect, so we ALSO raise `statusFailed` to surface a
				// "couldn't check connections" banner + retry (below) rather than strand
				// the user with buttonless, look-alike-disconnected rows.
				// Local-only: do NOT write a synthesized all-disconnected snapshot into
				// the shared ["provider-status"] cache — the chat gate derives
				// anyConnected across it, and a fake disconnect would falsely gate a
				// genuinely-connected user. Leave that cache alone on error.
				setConnectedById(
					Object.fromEntries(providers.map((p) => [p.id, false])),
				);
				setStatusFailed(true);
			});
	}, [runtime, applyStatus, providers]);

	// Clear the transient acknowledgement after a beat (all hooks + the connect flag).
	const { clearStatus: clearEffortStatus } = effort;
	const { clearStatus: clearModelStatus } = model;
	const { clearStatus: clearEnabledStatus } = enabledModels;
	useEffect(() => {
		if (saveStatus === "idle") return;
		const t = setTimeout(() => {
			clearEffortStatus();
			clearModelStatus();
			clearEnabledStatus();
			setConnectFailed(false);
		}, 2500);
		return () => clearTimeout(t);
	}, [saveStatus, clearEffortStatus, clearModelStatus, clearEnabledStatus]);

	// Requery connection on mount + on focus — login happens in a separate tab, so focus-return is when the outcome is known (ADR-0023).
	useEffect(() => {
		refreshConnected();
		const onFocus = () => refreshConnected();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshConnected]);

	// Live push: Core signals `provider/connected` on the originating connection
	// when credentials persist, so the card flips without waiting for focus-return
	// (ADR-0049). The push is a ping, not the truth — refetch `provider/status`
	// rather than patch (it carries `{provider}`, not `connected`). Route-scoped:
	// registered/torn down with the Models route, alongside the global
	// `thread/titled` handler (two real consumers of the by-method channel, ADR-0047).
	useEffect(() => {
		setNotificationHandler("provider/connected", () => refreshConnected());
		return () => clearNotificationHandler("provider/connected");
	}, [refreshConnected]);

	const { seed: seedEffort } = effort;
	const { seed: seedModel } = model;
	const { seed: seedEnabled } = enabledModels;
	// Load the catalog, tracking failure so the list can show an error+retry rather
	// than a blank Providers section. Exposed as a callback so the retry button and
	// the initial effect share one path.
	const loadCatalog = useCallback(() => {
		const requestId = ++latestCatalogRequest.current;
		return fetchCatalog(runtime)
			.then((c) => {
				if (requestId !== latestCatalogRequest.current) return;
				setProviders(c.providers);
				// Clear the failure only ON SUCCESS. Clearing it at call start would
				// swap the error+retry panel for the empty-list branch (nothing
				// rendered) the instant "Try again" is clicked — a blank flash until
				// the fetch settles, worse if the retry also fails.
				setCatalogFailed(false);
			})
			.catch(() => {
				if (requestId !== latestCatalogRequest.current) return;
				setCatalogFailed(true);
			});
	}, [runtime]);
	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (!alive) return;
				seedEffort(s.effort);
				seedModel(s.model);
				seedEnabled(s.enabled_models);
			})
			.catch(() => {});
		void loadCatalog();
		return () => {
			alive = false;
			// Invalidate any in-flight catalog load so a response landing after
			// unmount can't setState (mirrors the `alive` guard on the settings fetch).
			++latestCatalogRequest.current;
		};
	}, [runtime, seedEffort, seedModel, seedEnabled, loadCatalog]);

	// Full catalog ids across all providers — the materialized baseline when the
	// stored enabled set is empty(=all) and the user makes a first toggle (so the
	// wire carries an explicit set, not [] which would mean "all" again).
	const allModelIds = useMemo(
		() => providers.flatMap((p) => p.models).map((m) => m.id),
		[providers],
	);

	// Toggle a model's chat-enabled membership. The empty stored set means "all
	// enabled", so toggling OFF first materializes the full catalog, then drops the
	// id — never persisting []. Symmetrically, if a toggle leaves EVERY model
	// enabled we normalize back to [] (the uncurated sentinel) rather than persist
	// the full materialized catalog, which would re-freeze the set against future
	// catalog growth. The current default can't be disabled (mirrors Core's slice-2
	// invariant; the disabled toggle already blocks the click, this is
	// defense-in-depth so we never send a set excluding it). No-op until settings
	// load (`enabledModels.value === null`) — the toggle reads off a real set, not
	// the pre-load sentinel.
	const setModelEnabled = enabledModels.set;
	const currentDefault = model.value;
	const onToggleEnabled = useCallback(
		(id: string, next: boolean) => {
			const stored = enabledModels.value;
			if (stored === null) return;
			if (!next && id === currentDefault) return;
			const baseline = stored.length === 0 ? allModelIds : stored;
			const expanded = next
				? baseline.includes(id)
					? baseline
					: [...baseline, id]
				: baseline.filter((x) => x !== id);
			// Collapse "every model enabled" back to the uncurated sentinel.
			const nextSet =
				expanded.length === allModelIds.length &&
				allModelIds.every((m) => expanded.includes(m))
					? []
					: expanded;
			setModelEnabled(nextSet);
		},
		[enabledModels.value, allModelIds, currentDefault, setModelEnabled],
	);

	const onConnect = useCallback(
		(providerId: string) => {
			setBusy(true);
			setConnectFailed(false);
			startLogin(runtime, providerId)
				// A login that can't even start (helper missing, port busy) was
				// swallowed, leaving the user staring at an unchanged "Not connected"
				// row. Surface it.
				.catch(() => setConnectFailed(true))
				.finally(() => setBusy(false));
		},
		[runtime],
	);

	// Store the pasted key for a key-provider, then flip its row live through the
	// shared applyStatus chokepoint (the same path login/focus/push use). Rejects
	// on failure so the form surfaces the error and stays open; resolves + closes
	// the form on success. The form owns its own pending/error state.
	const onConfigure = useCallback(
		async (providerId: string, key: string) => {
			const status = await configure(runtime, providerId, key);
			// Bump the monotonic guard BEFORE committing: this invalidates any older
			// in-flight provider/status (a mount/focus poll carrying pre-configure
			// disconnected truth), so its resolution becomes a no-op and can't clobber
			// the just-configured connected value back to disconnected (ADR-0049).
			++latestStatusRequest.current;
			applyStatus(status);
			setConfiguringId(null);
		},
		[runtime, applyStatus],
	);

	const focused = providers.find((p) => p.id === selectedProvider);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-8">
			<div>
				<h2 className="mb-1 font-bold text-2xl">Models</h2>
				<p className="text-muted-foreground text-sm">
					Connect a provider, choose your preferred model, and set how hard it
					thinks.
				</p>
				{saveStatus !== "idle" && (
					<p
						role="status"
						className={
							saveStatus === "error"
								? "mt-2 text-destructive text-sm"
								: "mt-2 text-muted-foreground text-sm"
						}
					>
						{saveStatus === "error"
							? // A failed connect (login couldn't start) needs its own copy —
								// the generic save-failed line misdirects the user to the wrong
								// cause. connectFailed wins the shared error slot when set.
								connectFailed
								? "Couldn't start the connection. Try Connect again."
								: "Something didn't go through. Check that Inkstone is running and try again."
							: "Saved."}
					</p>
				)}
			</div>

			{focused && enabledModels.value !== null ? (
				<ProviderModelsDetail
					providerId={focused.id}
					label={focused.label}
					models={focused.models}
					// A disconnected provider's models can't be set as the default
					// (they'd run tokenless, ADR-0062) — lock select/toggle with a hint.
					connected={connectedById?.[focused.id] ?? false}
					selectedId={model.value}
					onSelect={model.set}
					// Only rendered once settings have seeded (`enabledModels.value !==
					// null`), so this is the real curated set — never the pre-load
					// sentinel. The catalog (which makes provider rows clickable) and
					// settings race on mount, so a fast click can land before settings
					// load; until then we keep showing the list (below) rather than
					// flash the detail as "all enabled" with no locked default.
					enabledIds={enabledModels.value}
					onToggleEnabled={onToggleEnabled}
					onBack={() => setSelectedProvider(null)}
					// provider/test liveness (ADR-0062), provider-agnostic. Probe the
					// model the user would actually use — the global default IF it
					// belongs to this provider, else the provider's first catalog model.
					// Disable when the provider has no models (nothing to probe).
					canTest={focused.models.length > 0}
					onTest={() => {
						const testModel = focused.models.some((m) => m.id === model.value)
							? (model.value as string)
							: focused.models[0]?.id;
						return testProvider(runtime, focused.id, testModel ?? "");
					}}
				/>
			) : (
				<>
					<div className="flex flex-col gap-3">
						<h3 className="font-semibold text-sm">Providers</h3>
						{catalogFailed && providers.length === 0 ? (
							// An unreachable catalog must not read as "no providers" — show an
							// honest error with a retry rather than a blank, dead list.
							<div className="flex flex-col items-start gap-2 rounded-md border border-input p-4">
								<p className="text-muted-foreground text-sm">
									Couldn't load providers. Check that Inkstone is running.
								</p>
								<Button
									variant="chip"
									size="sm"
									onClick={() => void loadCatalog()}
								>
									Try again
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								{statusFailed && (
									// provider/status couldn't be read — the rows below fell back
									// to a look-alike "Not connected" with no action button, so
									// surface an honest "couldn't check" notice + a retry (same
									// shape as the catalog-failure panel above). Retrying just
									// re-runs the stable refreshConnected, which clears this on
									// its own success.
									<div className="flex flex-col items-start gap-2 rounded-md border border-input p-4">
										<p className="text-muted-foreground text-sm">
											Couldn't check provider connections. Check that Inkstone
											is running.
										</p>
										<Button
											variant="chip"
											size="sm"
											onClick={() => refreshConnected()}
										>
											Try again
										</Button>
									</div>
								)}
								{providers.map((p) => {
									const connected = connectedById?.[p.id] ?? null;
									const status =
										connected === null
											? "Checking…"
											: connected
												? "Connected"
												: "Not connected";
									const count = p.models.length;
									// Auth kind comes off the provider/status wire row (ADR-0062),
									// not a client-side id guess. It is absent until a successful
									// status read supplies it — in particular the fetch-failed
									// recovery path synthesizes `connected: false` with NO wire auth
									// kind. Do NOT synthesize one (a defaulted "oauth" would render a
									// bogus Connect on a key-provider). While it is undefined we render
									// the row WITHOUT any auth-specific action button (just the neutral
									// status); the correct Connect/Configure affordance appears on the
									// next successful status read.
									const authKind: ProviderAuthKind | undefined =
										authKindById[p.id];
									return (
										<div key={p.id} className="flex flex-col gap-2">
											<div className="flex items-center gap-2 rounded-md border border-input pr-3">
												<button
													type="button"
													// The accessible NAME stays connect-free ("Open … models") so it
													// can't collide with the e2e `getByRole("button",{name:"Connect"})`
													// query (the status text "Not connected" contains "Connect").
													// The status + count ride along as the accessible DESCRIPTION via
													// aria-describedby, so assistive tech hears them too.
													aria-label={`Open ${p.label} models`}
													aria-describedby={`provider-meta-${p.id}`}
													onClick={() => setSelectedProvider(p.id)}
													className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
												>
													<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary font-semibold text-secondary-foreground text-sm">
														{p.label.slice(0, 1)}
													</div>
													<div className="flex min-w-0 flex-col">
														<span className="truncate font-medium text-sm">
															{p.label}
														</span>
														<span
															id={`provider-meta-${p.id}`}
															className="flex items-center gap-1.5 text-xs"
														>
															<span
																data-testid="provider-status"
																className={cn(
																	connected
																		? "text-foreground"
																		: "text-muted-foreground",
																)}
															>
																{status}
															</span>
															<span className="text-muted-foreground">
																· {count} {count === 1 ? "model" : "models"}
															</span>
														</span>
													</div>
													<ChevronRight
														className="ml-auto size-4 shrink-0 text-muted-foreground"
														aria-hidden
													/>
												</button>
												{/* The connect/onboarding affordance stays reachable per
											    provider row. Branch on auth kind (ADR-0062): an OAuth
											    provider (codex) offers Connect (opens the OAuth tab;
											    credential write is out-of-band, ADR-0023); a
											    key-configurable provider (OpenRouter) offers Configure,
											    which opens an inline paste-key form below the row. Until
											    a successful status supplies the auth kind
											    (`authKind === undefined`, e.g. the fetch-failure path)
											    render NO action button — a defaulted kind would show the
											    wrong affordance. */}
												{connected === false && authKind === "oauth" && (
													<Button
														variant="chip"
														size="sm"
														disabled={busy}
														onClick={() => onConnect(p.id)}
													>
														Connect
													</Button>
												)}
												{connected === false && authKind === "api_key" && (
													<Button
														variant="chip"
														size="sm"
														onClick={() =>
															setConfiguringId((cur) =>
																cur === p.id ? null : p.id,
															)
														}
													>
														Configure
													</Button>
												)}
											</div>
											{connected === false &&
												authKind === "api_key" &&
												configuringId === p.id && (
													<ProviderConfigureForm
														providerLabel={p.label}
														onSubmit={(key) => onConfigure(p.id, key)}
														onCancel={() => setConfiguringId(null)}
													/>
												)}
										</div>
									);
								})}
							</div>
						)}
					</div>

					<div className="flex flex-col gap-3">
						<div>
							<h3 className="font-semibold text-sm">Effort</h3>
							<p className="text-muted-foreground text-xs">
								How hard the model reasons before answering. Applies to every
								chat.
							</p>
						</div>
						<EffortControl value={effort.value} onChange={effort.set} />
					</div>
				</>
			)}
		</div>
	);
}

export const Route = createFileRoute("/settings/models")({
	component: ModelsSettings,
});
