/**
 * Per-`callId` diff preview state for the approval UI.
 *
 * Ephemeral overlay on top of persisted `DisplayPart`s: when a
 * `confirmDirs` approval carries a unified-diff preview, `ToolPart`
 * renders the diff inline below the tool header via OpenTUI's
 * `<diff>` renderable. Three independent cells support
 * auto-expand-while-pending plus user-driven toggle-to-re-expand:
 *
 *   - `pending`: diffs actively awaiting approval. Set by the provider
 *     closure before `setPendingApproval`; cleared when the approval
 *     resolves. Auto-expands the diff without touching `expanded`.
 *
 *   - `archive`: diffs retained after approval resolves so the user
 *     can re-expand them via the chevron in `ToolPart`. Populated
 *     alongside `pending` on `set`; never cleared on per-call resolve.
 *     Wiped wholesale on session boundaries (`clearSession` /
 *     `resumeSession`) and on provider unmount.
 *
 *   - `expanded`: user-toggled set of call ids. When a call id is in
 *     `expanded`, its archived diff renders even though the approval
 *     has resolved. Starts empty; flips via `toggle`.
 *
 * Single-read API for the renderer — `state(callId)` returns a
 * `ToolPartState` with both render decisions in one shot:
 *
 *   - `diff`: the preview body to render (pending auto-expand OR
 *     user-toggled archive), OR `undefined` when nothing should
 *     render.
 *   - `showChevron`: whether to render the `▸` / `▾` chevron
 *     affordance. True whenever the archive has an entry; the
 *     chevron glyph itself is picked by the caller from `diff`
 *     (present → `▾`, absent → `▸`).
 *
 * The two flags are independent: a completed tool call with an
 * archived diff but no user toggle has `{ diff: undefined,
 * showChevron: true }` — the collapsed-but-re-expandable state.
 *
 * Mutations are verb methods:
 *
 *   - `set(callId, preview)` → provider-closure helper. Writes to
 *     `pending` + `archive`. Does NOT touch `expanded` (new approvals
 *     auto-expand via the pending branch, not by flipping the user
 *     toggle).
 *   - `toggle(callId)` → flip `expanded` membership. No-op when no
 *     archive entry exists (a future renderer race).
 *   - `clear(callId)` → provider-closure cleanup on approval resolve.
 *     Removes from `pending` only; archive + expanded stay.
 *   - `clearAll()` → session-boundary reset. Wipes all three maps.
 *
 * Ordering: pi-agent-core emits `toolcall_end` as an assistant stream
 * event *before* `beforeToolCall` fires (the hook runs after argument
 * validation during execution preflight, see
 * `@mariozechner/pi-agent-core/dist/agent-loop.js`). So the reducer
 * pushes the pending `tool` DisplayPart first; `ToolPart` mounts with
 * `state(callId).diff === undefined`; then `confirmFn` writes the
 * preview and the reactive `state()` read triggers a re-render that
 * slots the `<diff>` in. The order-independence is the whole point
 * of keying by `callId` — a swap to an event-ordering that fires
 * `confirmFn` first would keep working without changes.
 *
 * Each of the three cells is its own `createSignal`. Copy-on-write
 * per mutation is still required (Solid signals identity-compare), so
 * `set` / `toggle` / `clear` allocate a fresh Map or Set for the
 * cells they touch. Splitting into three signals means a mutation
 * only re-triggers subscribers of the cell it actually changed, and
 * keeps the mutation helpers to one `setX(prev => ...)` call each —
 * no outer `Cells` wrapper, no cloning of unrelated cells.
 */

import { createSignal } from "solid-js";

export interface PendingPreview {
	filepath: string;
	unifiedDiff: string;
}

/**
 * Composite render-decision for one tool part. Bundles "should the
 * diff body render?" (`diff`) with "should the chevron affordance
 * render?" (`showChevron`) so the renderer does one read per part
 * and picks both decisions from the result.
 */
export interface ToolPartState {
	diff: PendingPreview | undefined;
	showChevron: boolean;
}

export interface PreviewRegistry {
	/** Composite render state for a tool part. One read per render. */
	state(callId: string): ToolPartState;
	/** Flip user-toggle membership; no-op when no archive entry. */
	toggle(callId: string): void;
	/** Provider-closure: write to pending + archive. */
	set(callId: string, preview: PendingPreview): void;
	/** Provider-closure: drop the pending entry on approval resolve. */
	clear(callId: string): void;
	/** Session-boundary reset: wipe everything. */
	clearAll(): void;
}

export function createPreviewRegistry(): PreviewRegistry {
	const [pending, setPending] = createSignal(new Map<string, PendingPreview>());
	const [archive, setArchive] = createSignal(new Map<string, PendingPreview>());
	const [expanded, setExpanded] = createSignal(new Set<string>());

	return {
		state(callId) {
			const p = pending().get(callId);
			const a = archive().get(callId);
			const diff = p ?? (expanded().has(callId) ? a : undefined);
			return {
				diff,
				showChevron: a !== undefined,
			};
		},
		toggle(callId) {
			// Guard against the renderer racing: if the archive never
			// had this id, there's no diff to toggle open — leave
			// `expanded` alone rather than admit a ghost entry.
			if (!archive().has(callId)) return;
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(callId)) next.delete(callId);
				else next.add(callId);
				return next;
			});
		},
		set(callId, preview) {
			setPending((prev) => {
				const next = new Map(prev);
				next.set(callId, preview);
				return next;
			});
			setArchive((prev) => {
				const next = new Map(prev);
				next.set(callId, preview);
				return next;
			});
		},
		clear(callId) {
			if (!pending().has(callId)) return;
			setPending((prev) => {
				const next = new Map(prev);
				next.delete(callId);
				return next;
			});
		},
		clearAll() {
			if (pending().size > 0) setPending(new Map());
			if (archive().size > 0) setArchive(new Map());
			if (expanded().size > 0) setExpanded(new Set());
		},
	};
}
