/**
 * Shared error-reporting hook for persisted-state access. The frontend
 * installs a handler (typically a toast) so the backend stays
 * frontend-agnostic; when unset, `console.error` is the fallback.
 *
 * Install *before* any write path runs. Load paths (action: "load")
 * fire at module init, before the frontend wires a handler — those hit
 * the `console.error` fallback, which is the intended user-visible
 * surface on startup.
 */

export interface PersistenceErrorContext {
	/**
	 * Which persisted surface failed. Lets frontends title their toasts.
	 * `"session"` covers the SQLite session store (sessions, messages,
	 * parts, agent_messages).
	 */
	kind: "config" | "auth" | "session";
	/** Short action label: "load", "save", "clear", "append-message", etc. */
	action: string;
	/** The thrown value. */
	error: unknown;
}

let handler: ((ctx: PersistenceErrorContext) => void) | null = null;

export function setPersistenceErrorHandler(
	fn: ((ctx: PersistenceErrorContext) => void) | null,
): void {
	handler = fn;
}

/**
 * Return the currently-installed handler (or null). Exposed so
 * frontends that install a handler on mount can restore the prior
 * value on unmount instead of null-clearing the global. Matches the
 * pattern `AgentProvider` uses for confirmFn lifecycle.
 */
export function getPersistenceErrorHandler():
	| ((ctx: PersistenceErrorContext) => void)
	| null {
	return handler;
}

/**
 * Sentinel flag key used by `runInTransaction`'s outer catch in
 * `sessions.ts` to dedup reports of the same rethrown error up the
 * chain. Exported as a shared constant so the tx wrapper and this
 * module stay in sync. Scoped narrowly on purpose: only the writer-
 * rethrow-then-outer-tx-catch chain needs dedup; making
 * `reportPersistenceError` globally idempotent would leak the flag
 * onto every error value the module ever sees (config, auth, load
 * paths), including errors external logging might serialize.
 */
export const REPORTED_SENTINEL = "__inkstoneReported";

export function reportPersistenceError(ctx: PersistenceErrorContext): void {
	if (handler) {
		try {
			handler(ctx);
			return;
		} catch {
			// Fall through to console.error if the handler itself throws —
			// never let error reporting become the new crash.
		}
	}
	const msg =
		ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
	console.error(`[inkstone] ${ctx.kind} ${ctx.action} failed: ${msg}`);
}
