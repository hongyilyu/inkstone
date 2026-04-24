import { homedir } from "node:os";

/**
 * Format a token count as a compact string.
 * e.g. 68700 -> "68.7K", 1200000 -> "1.2M"
 * Matches OpenCode's Locale.number() pattern.
 */
export function formatTokens(num: number): string {
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
	return num.toString();
}

/**
 * Format a token count as a full comma-separated number.
 * e.g. 158200 -> "158,200"
 * Used in the session sidebar where horizontal room permits precision.
 */
export function formatTokensFull(num: number): string {
	return num.toLocaleString("en-US");
}

const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

/**
 * Format a cost value as USD currency.
 * e.g. 2.25 -> "$2.25"
 */
export function formatCost(cost: number): string {
	return money.format(cost);
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * Ported from OpenCode's Locale.duration() (util/locale.ts:39-59).
 */
export function formatDuration(input: number): string {
	if (input < 1000) return `${input}ms`;
	if (input < 60000) return `${(input / 1000).toFixed(1)}s`;
	const minutes = Math.floor(input / 60000);
	const seconds = Math.floor((input % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/**
 * Collapse the user's home directory to `~` for display. Platform-neutral —
 * reads `os.homedir()` instead of assuming `/home/<user>`, so the Linux
 * `/home/...` and macOS `/Users/...` shapes both work.
 */
const HOME = homedir();
export function displayPath(p: string): string {
	if (HOME && (p === HOME || p.startsWith(`${HOME}/`))) {
		return `~${p.slice(HOME.length)}`;
	}
	return p;
}
