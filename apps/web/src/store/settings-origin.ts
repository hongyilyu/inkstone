import { createStore } from "zustand/vanilla";

/**
 * Where the settings takeover exits to: the last location visited *outside*
 * `/settings`. The root route records every navigation here (skipping settings
 * paths), so moving between settings tabs never overwrites it — Esc inside
 * settings returns to wherever it was opened from (Chat or Library), not a
 * previously-viewed tab. Read imperatively by the Esc handler; defaults to chat
 * (e.g. a cold deep-link straight to `/settings/*`). Matches the zustand-vanilla
 * store pattern in `store/command.ts` (ADR-0020).
 */
const store = createStore<{ exitHref: string }>()(() => ({ exitHref: "/" }));

export function noteNonSettingsLocation(href: string): void {
	if (!href.startsWith("/settings")) store.setState({ exitHref: href });
}

export function settingsExitHref(): string {
	return store.getState().exitHref;
}

/** Reset to the default — for test isolation. */
export function resetSettingsOrigin(): void {
	store.setState({ exitHref: "/" });
}
