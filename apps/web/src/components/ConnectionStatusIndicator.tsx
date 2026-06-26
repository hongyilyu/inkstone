import type { ConnectionStatus } from "@inkstone/ui-sdk";
import { Loader2, type LucideIcon, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConnectionStatus } from "@/store/connection";

/**
 * The visual + screen-reader payload of one connection status (ADR-0051). The
 * shell maps the ui-sdk enum here (the SDK emits the state; the UI decides how
 * it looks), so the mapping is a pure, independently unit-testable function.
 *
 * Per DESIGN.md:199 (status pairs a tiny dot with a word; color is never the
 * only signal): `connected` stays QUIET — a calm muted dot, no visible word — while
 * `reconnecting`/`disconnected` are more present. `tone` is an existing-palette
 * class only (`muted-foreground` / `destructive`); no new `--warning` token for
 * a transient state. `srLabel` always carries the meaning in TEXT for the
 * `role="status"` live region, so color/icon are never the sole cue.
 */
export function present(status: ConnectionStatus): {
	label: string;
	srLabel: string;
	tone: string;
	Icon: LucideIcon | null;
	showSpinner: boolean;
} {
	switch (status) {
		case "connected":
			return {
				label: "",
				// Silent at rest (matches CopyOutcome's empty `role="status"`): the
				// degraded states carry their meaning in visible word+icon, so the
				// connected resting state has nothing to announce. Recovery (back to
				// connected) is INTENTIONALLY unannounced — a polite live region
				// announces added/changed text, not a clear-to-empty — so the healthy
				// state stays quiet (ADR-0051); only the degraded states speak.
				srLabel: "",
				tone: "text-muted-foreground",
				Icon: null,
				showSpinner: false,
			};
		case "reconnecting":
			return {
				label: "Reconnecting…",
				srLabel: "Reconnecting to Inkstone…",
				tone: "text-muted-foreground",
				Icon: null,
				showSpinner: true,
			};
		case "disconnected":
			return {
				label: "Lost connection",
				srLabel: "Lost connection to Inkstone. Retrying…",
				tone: "text-destructive",
				Icon: WifiOff,
				showSpinner: false,
			};
	}
}

/**
 * Always-visible socket-liveness indicator (ADR-0051), mounted in the shared
 * NavShell footer so it shows on every authenticated route (chat + Library).
 * Reads the global connection store itself (so NavShell needn't thread a prop).
 *
 * The visible glyph + label are the sighted cue; a visually-hidden
 * `role="status" aria-live="polite"` region announces the state in TEXT
 * (mirrors `CopyOutcome` — an icon/color change alone is a sighted-only cue),
 * satisfying DESIGN.md:199 + WCAG + ADR-0051.
 */
export function ConnectionStatusIndicator() {
	const status = useConnectionStatus();
	const { label, srLabel, tone, Icon, showSpinner } = present(status);
	return (
		<div className={cn("flex items-center gap-1.5 text-xs", tone)}>
			{showSpinner ? (
				<Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
			) : Icon ? (
				<Icon className="size-3.5" aria-hidden />
			) : (
				// Quiet connected affordance: a tiny dot, no visible word.
				<span className="size-2 rounded-full bg-current" aria-hidden />
			)}
			{label && <span>{label}</span>}
			<span className="sr-only" role="status" aria-live="polite">
				{srLabel}
			</span>
		</div>
	);
}
