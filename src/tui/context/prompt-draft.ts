/**
 * Prompt-draft slot — module-level signal storing in-progress prompt
 * input keyed by `sessionId`.
 *
 * Why hoist out of the Prompt component: the Prompt unmounts whenever
 * `getSecondaryPage()` flips truthy (see `app.tsx`), and re-mounts
 * with empty local state on return. Anything stored in the component's
 * `text` signal or in the textarea's `extmarks` (the `@`-mention
 * spans) is lost on that round-trip. Hoisting the data above the
 * component lifetime fixes this without contorting the layout tree.
 *
 * Process-lifetime only — no disk persistence, no cross-launch
 * recovery. Quitting Inkstone discards drafts. The reported bug is
 * "navigate and come back," not "quit and come back"; disk-stash
 * (e.g. OpenCode's `/prompt.stash`) is a separable, additive feature
 * if a real need surfaces.
 *
 * Open-page drafts (no `sessionId` bound, `currentSessionId === null`)
 * are intentionally not preserved: the open page has no
 * round-trip surface that doesn't commit the draft via
 * router-fork.
 *
 * The `createRoot` wrapper mirrors `secondary-page.ts` — module-level
 * signals need an owner so Solid doesn't warn about computations
 * created outside a root and so the signal lives for the process
 * lifetime, surviving back-to-back `renderApp()` calls in tests.
 */

import { createRoot, createSignal } from "solid-js";

export interface DraftMention {
	start: number;
	end: number;
	path: string;
}

export interface Draft {
	text: string;
	mentions: DraftMention[];
}

const { drafts, setDrafts } = createRoot(() => {
	const [get, set] = createSignal<Map<string, Draft>>(new Map());
	return { drafts: get, setDrafts: set };
});

export function getDraft(sessionId: string): Draft | undefined {
	return drafts().get(sessionId);
}

export function setDraft(sessionId: string, draft: Draft): void {
	const next = new Map(drafts());
	next.set(sessionId, draft);
	setDrafts(next);
}

export function clearDraft(sessionId: string): void {
	const current = drafts();
	if (!current.has(sessionId)) return;
	const next = new Map(current);
	next.delete(sessionId);
	setDrafts(next);
}

/**
 * Test-only reset. Tests run back-to-back inside a single Bun process
 * and share the module-level signal; this lets a test isolate its
 * starting state without leaking drafts from a previous test.
 */
export function __resetDraftsForTesting(): void {
	setDrafts(new Map());
}
