import { Check } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

export interface ProviderConnectionCardProps {
	/** Display name, e.g. "ChatGPT". */
	name: string;
	/** `null` while the status query is in flight. */
	connected: boolean | null;
	busy?: boolean;
	onConnect: () => void;
}

/**
 * One provider's connection row (ADR-0023/0024), styled as a t3-like card.
 * Presentational: the parent runs `provider/status` + `provider/login_start`
 * (via `store/providers`) and feeds the state in. Connecting opens the
 * authorize URL in a new tab; the parent re-queries status on focus.
 */
export function ProviderConnectionCard({
	name,
	connected,
	busy = false,
	onConnect,
}: ProviderConnectionCardProps) {
	const status =
		connected === null
			? "Checking…"
			: connected
				? "Connected"
				: "Not connected";

	return (
		<Card className="flex items-center justify-between gap-4 p-4">
			<div className="flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary font-semibold text-secondary-foreground text-sm">
					{name.slice(0, 1)}
				</div>
				<div className="flex flex-col">
					<span className="font-medium text-sm">{name}</span>
					<span
						data-testid="provider-status"
						className={cn(
							"text-xs",
							connected ? "text-emerald-500" : "text-muted-foreground",
						)}
					>
						{status}
					</span>
				</div>
			</div>
			{connected ? (
				<span className="inline-flex items-center gap-1 font-medium text-emerald-500 text-xs">
					<Check className="size-4" aria-hidden />
					Connected
				</span>
			) : (
				<Button
					variant="chip"
					size="sm"
					disabled={busy || connected === null}
					onClick={onConnect}
				>
					Connect
				</Button>
			)}
		</Card>
	);
}
