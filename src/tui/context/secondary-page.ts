/**
 * Secondary page — local UI state for displaying a full-screen page
 * that replaces the conversation area. Per-session storage; see
 * `docs/ARCHITECTURE.md` § Per-session secondary page.
 */

import { createRoot, createSignal, untrack } from "solid-js";

export type SecondaryPageFormat = "markdown" | "text";

export interface SecondaryPageState {
	content: string;
	title?: string;
	/** `"text"` bypasses the markdown parser; defaults to `"markdown"`. */
	format?: SecondaryPageFormat;
}

interface RootState {
	pages: Map<string, SecondaryPageState>;
	sid: string | null;
}

const { state, setState, view, setView } = createRoot(() => {
	const [s, setS] = createSignal<RootState>({ pages: new Map(), sid: null });
	const [v, setV] = createSignal<SecondaryPageState | null>(null);
	return { state: s, setState: setS, view: v, setView: setV };
});

export function getSecondaryPage(): SecondaryPageState | null {
	return view();
}

export function setActiveSession(sid: string | null): void {
	// `untrack` breaks the read/write cycle with the caller's
	// `createEffect` — see `docs/ARCHITECTURE.md` § Per-session
	// secondary page. Same pattern as `prompt-draft-bridge.tsx`.
	untrack(() => {
		const s = state();
		if (s.sid === sid) return;
		setState({ ...s, sid });
		const next = sid !== null ? (s.pages.get(sid) ?? null) : null;
		setView(next);
	});
}

export function openSecondaryPage(page: SecondaryPageState): void {
	const s = state();
	if (s.sid === null) {
		// Pre-first-prompt / open-page surface: render directly
		// without per-session storage.
		setView(page);
		return;
	}
	const pages = new Map(s.pages);
	pages.set(s.sid, page);
	setState({ ...s, pages });
	setView(page);
}

export function closeSecondaryPage(): void {
	const s = state();
	if (s.sid !== null && s.pages.has(s.sid)) {
		const pages = new Map(s.pages);
		pages.delete(s.sid);
		setState({ ...s, pages });
	}
	setView(null);
}

export function __resetSecondaryPageForTesting(): void {
	setState({ pages: new Map(), sid: null });
	setView(null);
}
