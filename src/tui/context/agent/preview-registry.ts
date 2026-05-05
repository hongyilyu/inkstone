/**
 * Per-`callId` diff preview state for the approval UI. See
 * `docs/APPROVAL-UI.md` § State shapes for the full API, the three-
 * cell rationale, reactivity notes, and the event-ordering invariant.
 *
 * Tripwires:
 *   - Solid signals identity-compare, so mutations MUST copy-on-write.
 *     In-place Map/Set edits would not re-trigger subscribers.
 *   - `toggle` is a no-op when no archive entry exists — guards against
 *     a renderer race where the chevron click fires before the diff
 *     has landed.
 */

import { createSignal } from "solid-js";

export interface PendingPreview {
	filepath: string;
	unifiedDiff: string;
}

/** Single render-decision the renderer reads per `ToolPart`. */
export interface ToolPartState {
	diff: PendingPreview | undefined;
	showChevron: boolean;
}

export interface PreviewRegistry {
	state(callId: string): ToolPartState;
	toggle(callId: string): void;
	set(callId: string, preview: PendingPreview): void;
	clear(callId: string): void;
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
			return { diff, showChevron: a !== undefined };
		},
		toggle(callId) {
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
