import { createStore } from "zustand/vanilla";

// Where the settings takeover exits to: the last location visited outside `/settings` (defaults to chat).
// Recorded skipping settings paths so moving between tabs never overwrites it (ADR-0020 zustand-vanilla).
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
