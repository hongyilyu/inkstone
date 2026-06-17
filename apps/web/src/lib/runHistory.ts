import type { RunHistoryItem } from "@inkstone/protocol";
import {
	Ban,
	Check,
	Clock,
	LoaderCircle,
	type LucideIcon,
	TriangleAlert,
} from "lucide-react";

/** How a Run's latest milestone kind presents in the feed (ADR-0028 as-built).
 * Core returns the seven kinds verbatim; the Web client owns this mapping. */
export type RunHistoryView = {
	/** Human label shown on the row's second line. */
	label: string;
	/** Leading glyph — color is never the only signal (icon + word both carry kind). */
	icon: LucideIcon;
	/** Tone tier: `active` rations the magenta ink to live/awaiting Runs;
	 * `neutral` lets terminal success/cancel recede into warm-muted; `alert` is
	 * the one crimson, reserved for failure. */
	tone: "active" | "neutral" | "alert";
};

/** The kind → presentation table. `proposal_decided` is a *resumed-still-working*
 * Run (ADR-0028: `resume` writes no Run Log row), so it reads as live, not done;
 * `proposal_pending`/`parked` are both "Waiting" (awaiting a decision). */
export const RUN_HISTORY_VIEWS: Record<RunHistoryItem["kind"], RunHistoryView> =
	{
		running: { label: "Running", icon: LoaderCircle, tone: "active" },
		proposal_decided: {
			label: "Running, resumed",
			icon: LoaderCircle,
			tone: "active",
		},
		proposal_pending: { label: "Waiting", icon: Clock, tone: "active" },
		parked: { label: "Waiting", icon: Clock, tone: "active" },
		done: { label: "Done", icon: Check, tone: "neutral" },
		cancelled: { label: "Cancelled", icon: Ban, tone: "neutral" },
		error: { label: "Failed", icon: TriangleAlert, tone: "alert" },
	};

/** Tailwind text-color class per tone — magenta for active, warm-muted for
 * terminal, crimson alert for failure (the One-Ink rule, rationed). */
export const RUN_HISTORY_TONE_CLASS: Record<RunHistoryView["tone"], string> = {
	active: "text-primary",
	neutral: "text-muted-foreground",
	alert: "text-destructive",
};

/** Recency bucket label for an ms-epoch timestamp, on local-calendar-day
 * boundaries. Mirrors the Sidebar's thread grouping so the two rails read the
 * same way. */
export function runHistoryBucket(at: number, now: number = Date.now()): string {
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	const dayMs = 86_400_000;
	if (at >= startOfToday) return "Today";
	if (at >= startOfToday - dayMs) return "Yesterday";
	if (at >= startOfToday - 6 * dayMs) return "Earlier this week";
	return "Older";
}

/** The fixed bucket order; the feed renders only the non-empty ones. */
export const RUN_HISTORY_BUCKET_ORDER = [
	"Today",
	"Yesterday",
	"Earlier this week",
	"Older",
] as const;

/** A short clock/date stamp for a row's second line. Same-day Runs show the
 * time; older Runs show a compact month/day. */
export function formatRunTime(at: number, now: number = Date.now()): string {
	const d = new Date(at);
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	if (at >= startOfToday) {
		return d.toLocaleTimeString(undefined, {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
