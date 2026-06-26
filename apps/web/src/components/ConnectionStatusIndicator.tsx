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
 * a transient state.
 *
 * Two independent a11y knobs (separated so the healthy state is discoverable but
 * not noisy): `srLabel` is the text in the `role="status"` region — ALWAYS
 * non-empty so a screen-reader user navigating the footer can read the current
 * state (an empty region is undiscoverable; the visible dot/icon are
 * `aria-hidden`). `live` is the region's `aria-live`: `"off"` for `connected` so
 * the healthy state (incl. recovery back to connected) is present-but-NOT
 * auto-announced (PRODUCT.md local-first calm — no unsolicited "Connected" on
 * every mount/heal), `"polite"` for the degraded states so a drop/reconnect IS
 * announced. Color/icon are thus never the sole cue.
 */
export function present(status: ConnectionStatus): {
	label: string;
	srLabel: string;
	live: "off" | "polite";
	tone: string;
	Icon: LucideIcon | null;
	showSpinner: boolean;
} {
	switch (status) {
		case "connected":
			return {
				label: "",
				// Discoverable but silent: non-empty so SR users can read the healthy
				// state on navigation, `live: "off"` so it (and recovery to it) is
				// never auto-announced — only the degraded states speak (ADR-0051).
				srLabel: "Connected to Inkstone",
				live: "off",
				tone: "text-muted-foreground",
				Icon: null,
				showSpinner: false,
			};
		case "reconnecting":
			return {
				label: "Reconnecting…",
				srLabel: "Reconnecting to Inkstone…",
				live: "polite",
				tone: "text-muted-foreground",
				Icon: null,
				showSpinner: true,
			};
		case "disconnected":
			return {
				label: "Lost connection",
				srLabel: "Lost connection to Inkstone. Retrying…",
				live: "polite",
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
 * `role="status"` region carries the state in TEXT (mirrors `CopyOutcome` — an
 * icon/color change alone is a sighted-only cue). Its `aria-live` is per-state
 * (`present().live`): `off` for connected (readable on navigation, not
 * auto-announced), `polite` for the degraded states (a drop/reconnect speaks),
 * satisfying DESIGN.md:199 + WCAG + ADR-0051.
 */
export function ConnectionStatusIndicator() {
	const status = useConnectionStatus();
	const { label, srLabel, live, tone, Icon, showSpinner } = present(status);
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
			<span className="sr-only" role="status" aria-live={live}>
				{srLabel}
			</span>
		</div>
	);
}
