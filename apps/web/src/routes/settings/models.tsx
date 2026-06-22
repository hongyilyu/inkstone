import type { ModelInfo } from "@inkstone/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { EffortControl } from "@/components/EffortControl";
import { ModelCatalogTable } from "@/components/ModelCatalogTable";
import { ProviderConnectionCard } from "@/components/ProviderConnectionCard";
import {
	type SaveStatus,
	useOptimisticSetting,
} from "@/lib/hooks/useOptimisticSetting";
import { useRuntime } from "@/runtime";
import {
	fetchConnected,
	PROVIDER_OPENAI_CODEX,
	startLogin,
} from "@/store/providers";
import { fetchCatalog, fetchSettings, saveSettings } from "@/store/settings";

/** `/settings/models` (ADR-0024): provider connection, global effort control, and the catalog table with one Preferred model — persisted via `settings/*`, read from `model/catalog`. */
function ModelsSettings() {
	const runtime = useRuntime();
	const [connected, setConnected] = useState<boolean | null>(null);
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
		fetchConnected(runtime, PROVIDER_OPENAI_CODEX)
			.then(setConnected)
			.catch(() => setConnected(false));
	}, [runtime]);

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
