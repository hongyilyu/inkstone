import type { ProviderModels, ProviderStatusResult } from "@inkstone/protocol";
import {
	clearNotificationHandler,
	setNotificationHandler,
} from "@inkstone/ui-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EffortControl } from "@/components/EffortControl";
import { ProviderModelsDetail } from "@/components/ProviderModelsDetail";
import { Button } from "@/components/ui/button";
import {
	type SaveStatus,
	useOptimisticSetting,
} from "@/lib/hooks/useOptimisticSetting";
import { cn } from "@/lib/utils";
import { useRuntime } from "@/runtime";
import { fetchProviderStatus, startLogin } from "@/store/providers";
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
	// Latest in-flight provider/status request — guards refreshConnected's writes
	// against out-of-order resolution (see the useCallback below).
	const latestStatusRequest = useRef(0);
	const [busy, setBusy] = useState(false);
	const [providers, setProviders] = useState<readonly ProviderModels[]>([]);
	// Master/detail: null = provider list, otherwise the focused provider's id.
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	// Whether a provider login failed to start (surfaced in the shared status line).
	const [connectFailed, setConnectFailed] = useState(false);

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
				setConnectedById(
					Object.fromEntries(status.providers.map((p) => [p.id, p.connected])),
				);
				// Write the freshly-read truth into the shared ["provider-status"] cache
				// the chat gate (connect welcome + composer soft-disable) reads via
				// useProviderStatus. This is the single chokepoint — mount, focus, and the
				// `provider/connected` push all route through refreshConnected.
				//
				// setQueryData, NOT invalidateQueries: invalidate defaults to
				// type:"active", so while the chat column is unmounted (the user is over
				// here in /settings), the inactive chat query is only marked stale, not
				// refetched — it would still hold the OLD disconnected value. On returning
				// to chat, refetchOnMount serves that stale `success` data synchronously
				// before the refetch lands, flashing the connect screen at a now-connected
				// user. Writing the value keeps the cache truthful for that remount AND
				// notifies a still-mounted chat observer immediately (no refetch needed).
				queryClient.setQueryData<ProviderStatusResult>(
					["provider-status"],
					status,
				);
			})
			.catch(() => {
				if (requestId !== latestStatusRequest.current) return;
				// Status fetch failed: keep every KNOWN provider row actionable.
				// Resolve each loaded-catalog provider id to `connected: false` so the
				// row renders "Not connected" + a working Connect button — the
				// pre-slice recovery path — instead of a permanent "Checking…" (which
				// an empty map produced, since every id then resolved to null).
				// Local-only: do NOT write a synthesized all-disconnected snapshot into
				// the shared ["provider-status"] cache — the chat gate derives
				// anyConnected across it, and a fake disconnect would falsely gate a
				// genuinely-connected user. Leave that cache alone on error.
				setConnectedById(
					Object.fromEntries(providers.map((p) => [p.id, false])),
				);
			});
	}, [runtime, queryClient, providers]);

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
		fetchCatalog(runtime)
			.then((c) => {
				if (!alive) return;
				setProviders(c.providers);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [runtime, seedEffort, seedModel, seedEnabled]);

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
							? "Something didn't go through. Check that Inkstone is running and try again."
							: "Saved."}
					</p>
				)}
			</div>

			{focused ? (
				<ProviderModelsDetail
					label={focused.label}
					models={focused.models}
					selectedId={model.value}
					onSelect={model.set}
					// Pre-load (`null`) presents as uncurated (all enabled); the detail
					// is only reachable after a provider-row click, by which point
					// settings/get (fired on mount) has long since seeded the real set,
					// and onToggleEnabled no-ops while value is null — so a toggle can't
					// write off the sentinel.
					enabledIds={enabledModels.value ?? []}
					onToggleEnabled={onToggleEnabled}
					onBack={() => setSelectedProvider(null)}
				/>
			) : (
				<>
					<div className="flex flex-col gap-3">
						<h3 className="font-semibold text-sm">Providers</h3>
						<div className="flex flex-col gap-2">
							{providers.map((p) => {
								const connected = connectedById?.[p.id] ?? null;
								const status =
									connected === null
										? "Checking…"
										: connected
											? "Connected"
											: "Not connected";
								const count = p.models.length;
								return (
									<div
										key={p.id}
										className="flex items-center gap-2 rounded-md border border-input pr-3"
									>
										<button
											type="button"
											aria-label={`Open ${p.label} models`}
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
												<span className="flex items-center gap-1.5 text-xs">
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
										    provider row: a disconnected provider offers Connect
										    (opens the OAuth tab; credential write is out-of-band,
										    ADR-0023). */}
										{connected === false && (
											<Button
												variant="chip"
												size="sm"
												disabled={busy}
												onClick={() => onConnect(p.id)}
											>
												Connect
											</Button>
										)}
									</div>
								);
							})}
						</div>
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
