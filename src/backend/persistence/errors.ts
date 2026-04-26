/**
 * Shared error-reporting hook for persisted-state access.
 *
 * `config.ts`, `auth.ts`, and the SQLite session store (`sessions.ts`,
 * `import-legacy.ts`, `db/client.ts`) all touch disk synchronously and
 * can fail on disk-full, permission-denied, read-only-filesystem, or
 * schema-drift conditions. Without a hook, a bare throw would crash the
 * TUI; swallowing silently would hide a real data-loss event. This module
 * provides a single injection point that a frontend wires to a toast (or
 * logger, test spy, etc.) so the backend stays frontend-agnostic.
 *
 * Install a handler from the frontend *before* any write path runs. Load
 * paths (action: "load") run at module init, before the frontend has had
 * a chance to install a handler; for those cases the fallback
 * `console.error` is the intended user-visible surface — TUI users always
 * have a terminal open, so the message is visible on startup.
 */

export interface PersistenceErrorContext {
	/**
	 * Which persisted surface failed. Lets frontends title their toasts.
	 * `"session"` covers both the legacy `session.json` and the SQLite
	 * session store (messages, parts, agent_messages, events, memory).
	 */
	kind: "config" | "auth" | "session" | "db";
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
