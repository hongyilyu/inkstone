/**
 * Shared error-reporting hook for persistence writes.
 *
 * Both `config.ts` and `session.ts` do synchronous `writeFileSync` calls that
 * can fail on disk-full, permission-denied, or read-only-filesystem
 * conditions. Without a hook, a bare throw would crash the TUI; swallowing
 * silently would hide a real data-loss event. This module provides a single
 * injection point that a frontend wires to a toast (or logger, test spy,
 * etc.) so the backend stays frontend-agnostic.
 *
 * Install a handler from the frontend *before* any write path runs. If no
 * handler is installed, `reportPersistenceError` falls back to
 * `console.error` so bugs aren't silent.
 */

export interface PersistenceErrorContext {
	/** Which persistence surface failed. Lets frontends title their toasts. */
	kind: "config" | "session";
	/** Short action label: "save", "clear", etc. */
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
