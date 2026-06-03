import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { EffortControl, type EffortLevel } from "@/components/EffortControl";
import { ProviderConnectionCard } from "@/components/ProviderConnectionCard";
import { useRuntime } from "@/runtime";
import {
	fetchConnected,
	PROVIDER_OPENAI_CODEX,
	startLogin,
} from "@/store/providers";
import { fetchSettings, saveSettings } from "@/store/settings";

/**
 * `/settings/models` (ADR-0024). Slice 5: provider connection (restyled OAuth)
 * + a global effort control wired to `settings/*`. The model catalog table +
 * preferred selection land in slice 6.
 */
function ModelsSettings() {
	const runtime = useRuntime();
	const [connected, setConnected] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [effort, setEffort] = useState<string>("off");

	const refreshConnected = useCallback(() => {
		fetchConnected(runtime, PROVIDER_OPENAI_CODEX)
			.then(setConnected)
			.catch(() => setConnected(false));
	}, [runtime]);

	// Connection: query on mount + on focus (the login tab is separate, so
	// focus-return is when the outcome is known — same pattern as ADR-0023).
	useEffect(() => {
		refreshConnected();
		const onFocus = () => refreshConnected();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshConnected]);

	// Load the persisted global effort once.
	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (alive) setEffort(s.effort);
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
		</div>
	);
}

export const Route = createFileRoute("/settings/models")({
	component: ModelsSettings,
});
