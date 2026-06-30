import type { ModelInfo, ProviderStatusResult } from "@inkstone/protocol";
import {
	clearNotificationHandler,
	setNotificationHandler,
} from "@inkstone/ui-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { EffortControl } from "@/components/EffortControl";
import { ModelCatalogTable } from "@/components/ModelCatalogTable";
import { ProviderConnectionCard } from "@/components/ProviderConnectionCard";
import {
	type SaveStatus,
	useOptimisticSetting,
} from "@/lib/hooks/useOptimisticSetting";
import { useRuntime } from "@/runtime";
import {
	fetchProviderStatus,
	PROVIDER_OPENAI_CODEX,
	startLogin,
} from "@/store/providers";
import { fetchCatalog, fetchSettings, saveSettings } from "@/store/settings";

/** `/settings/models` (ADR-0024): provider connection, global effort control, and the catalog table with one Preferred model — persisted via `settings/*`, read from `model/catalog`. */
function ModelsSettings() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const [connected, setConnected] = useState<boolean | null>(null);
	// Latest in-flight provider/status request — guards refreshConnected's writes
	// against out-of-order resolution (see the useCallback below).
	const latestStatusRequest = useRef(0);
	const [busy, setBusy] = useState(false);
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
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

	// One shared acknowledgement line for the section: error wins over saved.
	const saveStatus: SaveStatus = connectFailed
		? "error"
		: effort.status === "error" || model.status === "error"
			? "error"
			: effort.status === "saved" || model.status === "saved"
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
		// Read the FULL provider/status payload (not just this provider's bool): the
		// shared cache is the chat gate's source of truth and useProviderStatus
		// derives `anyConnected` across ALL providers[], so writing a synthesized
		// single-row snapshot would drop any other connected provider. Derive this
		// card's flag from the same payload — one round-trip, no resynthesis.
		fetchProviderStatus(runtime)
			.then((status) => {
				if (requestId !== latestStatusRequest.current) return;
				setConnected(
					status.providers.find((p) => p.id === PROVIDER_OPENAI_CODEX)
						?.connected ?? false,
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
				setConnected(false);
			});
	}, [runtime, queryClient]);

	// Clear the transient acknowledgement after a beat (both hooks + the connect flag).
	const { clearStatus: clearEffortStatus } = effort;
	const { clearStatus: clearModelStatus } = model;
	useEffect(() => {
		if (saveStatus === "idle") return;
		const t = setTimeout(() => {
			clearEffortStatus();
			clearModelStatus();
			setConnectFailed(false);
		}, 2500);
		return () => clearTimeout(t);
	}, [saveStatus, clearEffortStatus, clearModelStatus]);

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
	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (!alive) return;
				seedEffort(s.effort);
				seedModel(s.model);
			})
			.catch(() => {});
		fetchCatalog(runtime)
			.then((c) => {
				if (!alive) return;
				setModels(c.providers.flatMap((p) => p.models));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [runtime, seedEffort, seedModel]);

	const onConnect = useCallback(() => {
		setBusy(true);
		setConnectFailed(false);
		startLogin(runtime, PROVIDER_OPENAI_CODEX)
			// A login that can't even start (helper missing, port busy) was swallowed,
			// leaving the user staring at an unchanged "Not connected" card. Surface it.
			.catch(() => setConnectFailed(true))
			.finally(() => setBusy(false));
	}, [runtime]);

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

			<div className="flex flex-col gap-3">
				<h3 className="font-semibold text-sm">Provider</h3>
				<ProviderConnectionCard
					name="ChatGPT"
					connected={connected}
					busy={busy}
					onConnect={onConnect}
				/>
			</div>

			<div className="flex flex-col gap-3">
				<div>
					<h3 className="font-semibold text-sm">Effort</h3>
					<p className="text-muted-foreground text-xs">
						How hard the model reasons before answering. Applies to every chat.
					</p>
				</div>
				<EffortControl value={effort.value} onChange={effort.set} />
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-3">
				<div>
					<h3 className="font-semibold text-sm">Preferred model</h3>
					<p className="text-muted-foreground text-xs">
						The model new chats use by default.
					</p>
				</div>
				<ModelCatalogTable
					models={models}
					selectedId={model.value}
					onSelect={model.set}
				/>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/settings/models")({
	component: ModelsSettings,
});
