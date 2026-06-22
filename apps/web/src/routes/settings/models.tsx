import type { ModelInfo } from "@inkstone/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { EffortControl, type EffortLevel } from "@/components/EffortControl";
import { ModelCatalogTable } from "@/components/ModelCatalogTable";
import { ProviderConnectionCard } from "@/components/ProviderConnectionCard";
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
	const [effort, setEffort] = useState<string>("off");
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);
	// Acknowledge a settings write: "saved" on success, "error" if it failed (so a
	// failed save isn't swallowed silently while the optimistic value reverts).
	const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">(
		"idle",
	);
	// Monotonic per-field save tokens (latest-write-wins): a save commits/rolls back
	// only if it's still the newest for its field, so rapid clicks can't interleave
	// (an older response overwriting a newer choice). Network stays concurrent; only
	// the EFFECT is serialized to the user's last action.
	const effortSaveToken = useRef(0);
	const modelSaveToken = useRef(0);

	const refreshConnected = useCallback(() => {
		fetchConnected(runtime, PROVIDER_OPENAI_CODEX)
			.then(setConnected)
			.catch(() => setConnected(false));
	}, [runtime]);

	// Clear the save acknowledgement after a beat so it reads as transient feedback.
	useEffect(() => {
		if (saveStatus === "idle") return;
		const t = setTimeout(() => setSaveStatus("idle"), 2500);
		return () => clearTimeout(t);
	}, [saveStatus]);

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
		setSaveStatus("idle");
		startLogin(runtime, PROVIDER_OPENAI_CODEX)
			// A login that can't even start (helper missing, port busy) was swallowed,
			// leaving the user staring at an unchanged "Not connected" card. Surface it.
			.catch(() => setSaveStatus("error"))
			.finally(() => setBusy(false));
	}, [runtime]);

	const onEffortChange = useCallback(
		(next: EffortLevel) => {
			const prev = effort; // capture for rollback
			const token = ++effortSaveToken.current; // latest-write-wins guard
			setEffort(next); // optimistic
			saveSettings(runtime, { effort: next })
				.then((s) => {
					// Ignore an out-of-order response: a newer click already superseded
					// this one, so its value must not overwrite the newer choice.
					if (token !== effortSaveToken.current) return;
					setEffort(s.effort);
					setSaveStatus("saved");
				})
				.catch(() => {
					if (token !== effortSaveToken.current) return;
					setEffort(prev); // revert the optimistic value
					setSaveStatus("error");
				});
		},
		[runtime, effort],
	);

	const onSelectModel = useCallback(
		(id: string) => {
			const prev = selectedModel; // capture for rollback
			const token = ++modelSaveToken.current; // latest-write-wins guard
			setSelectedModel(id); // optimistic
			saveSettings(runtime, { model: id })
				.then((s) => {
					if (token !== modelSaveToken.current) return;
					setSelectedModel(s.model);
					setSaveStatus("saved");
				})
				.catch(() => {
					if (token !== modelSaveToken.current) return;
					setSelectedModel(prev); // revert the optimistic value
					setSaveStatus("error");
				});
		},
		[runtime, selectedModel],
	);

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
