/**
 * Ephemeral per-`callId` diff preview store.
 *
 * Phase 4 attaches the unified-diff string produced by a `confirmDirs`
 * approval to the tool call it targets, so `ToolPart` can render the
 * diff inline below the args line. Two shapes were considered:
 *
 *   1. Widen `DisplayPart` tool variant with `diff?: string`. Simpler
 *      at the render site, but `DisplayPart` is persisted verbatim to
 *      SQLite (`src/backend/persistence/sessions.ts` stores the tool
 *      part's `{ name, args, state, error? }` blob), so adding a
 *      `diff` field would either leak into persistence (stale diff
 *      after resume) or require persistence-layer carve-outs.
 *
 *   2. Carry the diff in a parallel per-`callId` map, looked up by
 *      `ToolPart` at render time. Persistence is untouched; the diff
 *      is strictly a live-session overlay on top of what SQLite holds.
 *
 * We went with (2). The overlay is a Solid signal so subscribers
 * re-render when an entry lands or clears; the store itself is a
 * `Map<callId, PendingPreview>` captured in a signal cell. Ephemeral
 * by construction: provider unmount resets it.
 *
 * Event ordering: pi-agent-core emits `toolcall_end` as an assistant
 * stream event *before* the `beforeToolCall` hook fires (the hook runs
 * after argument validation during the execution preflight, see
 * `@mariozechner/pi-agent-core/dist/agent-loop.js`). So the reducer
 * pushes the pending `tool` DisplayPart first, `ToolPart` mounts with
 * `previews.get(callId) === undefined`, then `confirmFn` writes the
 * preview. That `setMap` re-triggers `ToolPart`'s reactive
 * `previews.get(...)` read and the `<diff>` slots in. The
 * order-independence is the whole point of keying by `callId` — a
 * swap to an event-ordering that fires `confirmFn` first would keep
 * working without changes.
 *
 * Does NOT reset on `clearSession` today. A `confirmFn` in flight
 * blocks the Prompt cell, so `/clear` can't fire while a preview is
 * live; nothing in the registry survives past the approval resolve.
 * If phase 5 changes that gating, thread a `clearAll()` into the
 * session-lifecycle hooks.
 */

import { createSignal } from "solid-js";

export interface PendingPreview {
	filepath: string;
	unifiedDiff: string;
}

export interface PreviewRegistry {
	/** Read the current preview for a given tool-call id. */
	get(callId: string): PendingPreview | undefined;
	/** Attach (or replace) the preview for `callId`. */
	set(callId: string, preview: PendingPreview): void;
	/** Drop the preview for `callId`. No-op if absent. */
	clear(callId: string): void;
	/** Drop every entry. Used on `clearSession` / provider unmount. */
	clearAll(): void;
}

export function createPreviewRegistry(): PreviewRegistry {
	// Wrapped in a signal cell so `get()` reads reactively — OpenTUI's
	// Solid reconciler tracks the cell access in effects/memos that
	// consume `preview` inside a render. Replacing the Map identity
	// on every mutation would be heavier and no more correct; a
	// single-signal cell + explicit `.notify()` via reassigning the
	// same reference works because Solid compares by identity only
	// for the *outer* cell value.
	//
	// We reassign a fresh Map on every write. That's fine: approval
	// writes are rare (one per user confirmation), so the
	// copy-on-write cost is invisible.
	const [map, setMap] = createSignal(new Map<string, PendingPreview>());

	return {
		get(callId) {
			return map().get(callId);
		},
		set(callId, preview) {
			setMap((prev) => {
				const next = new Map(prev);
				next.set(callId, preview);
				return next;
			});
		},
		clear(callId) {
			setMap((prev) => {
				if (!prev.has(callId)) return prev;
				const next = new Map(prev);
				next.delete(callId);
				return next;
			});
		},
		clearAll() {
			setMap((prev) => (prev.size === 0 ? prev : new Map()));
		},
	};
}
