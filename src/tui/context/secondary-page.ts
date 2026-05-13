/**
 * Secondary page — per-session, browser-style back/forward navigation
 * for the full-screen overlay that replaces the conversation. See ADR
 * 0017 and `docs/ARCHITECTURE.md` § Secondary-page back/forward
 * history.
 */

import { createRoot, createSignal, untrack } from "solid-js";

export type SecondaryPageFormat = "markdown" | "text";

export interface SecondaryPageState {
	content: string;
	title?: string;
	/** `"text"` bypasses the markdown parser; defaults to `"markdown"`. */
	format?: SecondaryPageFormat;
}

interface SessionNav {
	back: SecondaryPageState[];
	current: SecondaryPageState | null;
	forward: SecondaryPageState[];
}

interface NavRoot {
	map: Map<string, SessionNav>;
	sid: string | null;
}

const { state, setState, view, setView } = createRoot(() => {
	const [s, setS] = createSignal<NavRoot>({ map: new Map(), sid: null });
	const [v, setV] = createSignal<SecondaryPageState | null>(null);
	return { state: s, setState: setS, view: v, setView: setV };
});

export function getSecondaryPage(): SecondaryPageState | null {
	return view();
}

export function setActiveSession(sid: string | null): void {
	// `untrack` breaks the read/write cycle with the caller's
	// `createEffect` (whose tracked dep is the session-id accessor).
	// Same pattern as `prompt-draft-bridge.tsx`.
	untrack(() => {
		const s = state();
		if (s.sid === sid) return;
		setState({ ...s, sid });
		const nav = sid !== null ? s.map.get(sid) : undefined;
		setView(nav?.current ?? null);
	});
}

function navigateTo(page: SecondaryPageState): void {
	const s = state();
	if (s.sid === null) {
		// Pre-first-prompt / open-page surface: render directly,
		// no per-session storage.
		setView(page);
		return;
	}
	const cur = s.map.get(s.sid) ?? { back: [], current: null, forward: [] };
	const nextNav: SessionNav = {
		// Conversation (current === null) is the implicit floor of
		// `back`, not a stack entry. Pushing null would let `goBack`
		// pop a phantom entry. See ADR 0017.
		back: cur.current != null ? [...cur.back, cur.current] : [...cur.back],
		current: page,
		forward: [],
	};
	const nextMap = new Map(s.map);
	nextMap.set(s.sid, nextNav);
	setState({ ...s, map: nextMap });
	setView(page);
}

export function goBack(): void {
	const s = state();
	if (s.sid === null) {
		setView(null);
		return;
	}
	const cur = s.map.get(s.sid);
	if (!cur || (cur.current == null && cur.back.length === 0)) return;
	const newCurrent: SecondaryPageState | null = cur.back.at(-1) ?? null;
	const newBack = cur.back.slice(0, -1);
	const newForward =
		cur.current != null ? [...cur.forward, cur.current] : [...cur.forward];
	const nextNav: SessionNav = {
		back: newBack,
		current: newCurrent,
		forward: newForward,
	};
	const nextMap = new Map(s.map);
	nextMap.set(s.sid, nextNav);
	setState({ ...s, map: nextMap });
	setView(newCurrent);
}

export function goForward(): void {
	const s = state();
	if (s.sid === null) return;
	const cur = s.map.get(s.sid);
	if (!cur || cur.forward.length === 0) return;
	const newCurrent: SecondaryPageState | null = cur.forward.at(-1) ?? null;
	const newForward = cur.forward.slice(0, -1);
	const newBack =
		cur.current != null ? [...cur.back, cur.current] : [...cur.back];
	const nextNav: SessionNav = {
		back: newBack,
		current: newCurrent,
		forward: newForward,
	};
	const nextMap = new Map(s.map);
	nextMap.set(s.sid, nextNav);
	setState({ ...s, map: nextMap });
	setView(newCurrent);
}

export function canGoBack(): boolean {
	const s = state();
	if (s.sid === null) return false;
	const nav = s.map.get(s.sid);
	if (!nav) return false;
	return nav.back.length > 0 || nav.current != null;
}

export function canGoForward(): boolean {
	const s = state();
	if (s.sid === null) return false;
	const nav = s.map.get(s.sid);
	return nav ? nav.forward.length > 0 : false;
}

export function openSecondaryPage(page: SecondaryPageState): void {
	navigateTo(page);
}

/**
 * Close the page AND wipe the current session's history. For `/clear`
 * (session destroyed → nav graph goes with it) and the test-harness
 * `afterEach`. Resume does NOT call this — the bridge handles view-
 * sync on session change.
 */
export function closeSecondaryPage(): void {
	const s = state();
	if (s.sid !== null && s.map.has(s.sid)) {
		const nextMap = new Map(s.map);
		nextMap.delete(s.sid);
		setState({ ...s, map: nextMap });
	}
	setView(null);
}

export function __resetSecondaryPageForTesting(): void {
	setState({ map: new Map(), sid: null });
	setView(null);
}
