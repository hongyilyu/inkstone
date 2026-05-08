/**
 * Module-scoped pending signal for the provider-disconnect
 * confirmation flow. Parallel shape to `pendingApproval` /
 * `pendingSuggestion` in `agent/provider.tsx` — see
 * `docs/APPROVAL-UI.md` for the per-action signal rationale.
 *
 * Disconnect runs outside any agent turn (no `isStreaming` deadlock
 * concern), and is invoked from a single non-component call site
 * (`confirm-and-disconnect.ts`) and consumed at a single render site
 * (`app.tsx` Layout). A module signal is the simplest layer that
 * supports the async `Promise<boolean>` API.
 */

import { createSignal } from "solid-js";

export interface PendingDisconnect {
	title: string;
	message: string;
}

interface PendingEntry {
	request: PendingDisconnect;
	resolve: (ok: boolean) => void;
}

const [pending, setPending] = createSignal<PendingEntry | null>(null);

export const pendingDisconnect = (): PendingDisconnect | null =>
	pending()?.request ?? null;

/**
 * Single-flight today: `confirm-and-disconnect.ts` is the only caller
 * and always runs `dialog.clear()` first, which closes the manage
 * menu that's the only path to a disconnect. If a second caller is
 * ever added, this function needs to either (a) reject if `pending()`
 * is already set, or (b) queue. Today it would orphan the in-flight
 * resolver — caller would hang.
 */
export function requestDisconnectConfirmation(
	request: PendingDisconnect,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		setPending({ request, resolve });
	});
}

export function respondDisconnect(ok: boolean): void {
	const entry = pending();
	if (!entry) return;
	// Clear first so the panel unmounts before the awaiting caller
	// resumes — mirrors the `respondApproval` ordering in
	// agent/provider.tsx so a fast follow-up call doesn't race the
	// unmount.
	setPending(null);
	entry.resolve(ok);
}
