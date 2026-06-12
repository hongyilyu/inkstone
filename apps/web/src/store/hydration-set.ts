// Threads already "live" and excluded from hydrate-on-focus (slice 13). Its own module so
// both bridge.ts and hydrate.ts import it without a bridge → hydrate → bridge cycle.
const hydrated = new Set<string>();

/** Mark a thread as already live (skips hydrate-on-focus). */
export function markThreadHydrated(threadId: string): void {
	hydrated.add(threadId);
}

/** True when the thread is already live and must not be re-hydrated. */
export function isThreadHydrated(threadId: string): boolean {
	return hydrated.has(threadId);
}

/** Reset the hydrated set — for test isolation. */
export function resetHydration(): void {
	hydrated.clear();
}
