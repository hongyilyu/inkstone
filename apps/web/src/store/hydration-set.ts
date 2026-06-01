/**
 * The set of threads that are already "live" in the store and must NOT be
 * hydrated-on-focus (slice 13): either already hydrated via `thread/get`, or
 * locally-originated (minted by `sendNewThread` / sent into by `send`). A
 * locally-originated thread already has its messages + an attached stream, so
 * re-hydrating it on focus would double up history and resubscribe its run.
 *
 * This lives in its own module so BOTH `bridge.ts` (marks locally-originated
 * threads) and `hydrate.ts` (consults + records on hydrate) import it without a
 * `bridge → hydrate → bridge` import cycle.
 */
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
