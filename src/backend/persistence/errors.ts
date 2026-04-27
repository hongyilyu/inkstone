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
