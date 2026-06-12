import type { ModelInfo } from "@inkstone/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { EffortControl, type EffortLevel } from "@/components/EffortControl";
import { ModelCatalogTable } from "@/components/ModelCatalogTable";
import { ProviderConnectionCard } from "@/components/ProviderConnectionCard";
import { useRuntime } from "@/runtime";
import {
	PROVIDER_OPENAI_CODEX,
	fetchConnected,
	startLogin,
} from "@/store/providers";
import { fetchCatalog, fetchSettings, saveSettings } from "@/store/settings";

/** `/settings/models` (ADR-0024): provider connection, global effort control, and the catalog table with one Preferred model — persisted via `settings/*`, read from `model/catalog`. */
function ModelsSettings() {
	const runtime = useRuntime();
	const [connected, setConnected] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [effort, setEffort] = useState<string>("off");
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);

	const refreshConnected = useCallback(() => {
		fetchConnected(runtime, PROVIDER_OPENAI_CODEX)
			.then(setConnected)
			.catch(() => setConnected(false));
	}, [runtime]);

	// Requery connection on mount + on focus — login happens in a separate tab, so focus-return is when the outcome is known (ADR-0023).
	useEffect(() => {
		refreshConnected();
		const onFocus = () => refreshConnected();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshConnected]);

	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (!alive) return;
				setEffort(s.effort);
				setSelectedModel(s.model);
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
	}, [runtime]);

	const onConnect = useCallback(() => {
		setBusy(true);
		startLogin(runtime, PROVIDER_OPENAI_CODEX)
			.catch(() => {})
			.finally(() => setBusy(false));
	}, [runtime]);

	const onEffortChange = useCallback(
		(next: EffortLevel) => {
			setEffort(next); // optimistic
			saveSettings(runtime, { effort: next })
				.then((s) => setEffort(s.effort))
				.catch(() => {});
		},
		[runtime],
	);

	const onSelectModel = useCallback(
		(id: string) => {
			setSelectedModel(id); // optimistic
			saveSettings(runtime, { model: id })
				.then((s) => setSelectedModel(s.model))
				.catch(() => {});
		},
		[runtime],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-8">
			<div>
				<h2 className="mb-1 font-bold text-2xl">Models</h2>
				<p className="text-muted-foreground text-sm">
					Connect a provider, choose your preferred model, and set how hard it
					thinks.
				</p>
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
				<EffortControl value={effort} onChange={onEffortChange} />
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
					selectedId={selectedModel}
					onSelect={onSelectModel}
				/>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/settings/models")({
	component: ModelsSettings,
});
