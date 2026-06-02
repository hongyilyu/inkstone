import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "../runtime.js";
import {
	type OpenUrl,
	PROVIDER_OPENAI_CODEX,
	fetchConnected,
	startLogin,
} from "../store/providers.js";
import { Button } from "./ui/button.js";

/**
 * Settings → Providers (ADR-0023, ADR-0014 amendment). Scrappy first cut:
 * one ChatGPT row showing connected/disconnected with a Connect button.
 * Clicking Connect asks Core for the authorize URL and opens it in a NEW TAB;
 * because this tab stays alive, it re-queries `provider/status` on window
 * focus to flip to Connected when the user returns. No live notification.
 *
 * `openUrl` is injected for tests (default `window.open`).
 */
export interface SettingsPanelProps {
	openUrl?: OpenUrl;
}

export function SettingsPanel({ openUrl }: SettingsPanelProps = {}) {
	const runtime = useRuntime();
	const [connected, setConnected] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(() => {
		fetchConnected(runtime, PROVIDER_OPENAI_CODEX)
			.then(setConnected)
			.catch(() => setConnected(false));
	}, [runtime]);

	// Query on mount, and re-query whenever the window regains focus — the
	// login tab is separate, so focus-return is when the outcome is known.
	useEffect(() => {
		refresh();
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const onConnect = useCallback(() => {
		setBusy(true);
		startLogin(runtime, PROVIDER_OPENAI_CODEX, openUrl)
			.catch(() => {})
			.finally(() => setBusy(false));
	}, [runtime, openUrl]);

	return (
		<section aria-label="Providers" className="flex flex-col gap-3 p-4">
			<h2 className="font-medium text-sm">Providers</h2>
			<div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
				<div className="flex flex-col">
					<span className="text-sm">ChatGPT</span>
					<span
						className="text-muted-foreground text-xs"
						data-testid="chatgpt-status"
					>
						{connected === null
							? "Checking…"
							: connected
								? "Connected"
								: "Disconnected"}
					</span>
				</div>
				<Button
					variant="chip"
					size="sm"
					disabled={busy || connected === true}
					onClick={onConnect}
				>
					{connected === true ? "Connected" : "Connect"}
				</Button>
			</div>
		</section>
	);
}
