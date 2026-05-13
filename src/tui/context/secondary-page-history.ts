/**
 * Per-session, browser-style back/forward history for the secondary
 * page overlay.
 *
 * `secondary-page.ts` was originally a single `Signal<State | null>` —
 * "what is currently rendered" with no notion of previous or next.
 * This module promotes it to a real navigation graph: each session
 * owns its own `{ back, current, forward }` triple, switched by
 * Ctrl+[ / Ctrl+], identical in semantics to a browser tab's
 * back / forward buttons.
 *
 * Two signals back-to-back so the surface stays small:
 *   - `state` — `{ map, sid }`. `map` is `Map<sessionId, SessionNav>`,
 *     `sid` mirrors the AgentProvider's current session id. Updated
 *     by `setActiveSession` (called from the layout-keybinds hook,
 *     which is the only place that has reactive access to
 *     `subscribeSessionId()`).
 *   - `view` — `SecondaryPageState | null`. The currently-rendered
 *     page. Derived from `map.get(sid)?.current` whenever any of the
 *     three nav functions or `setActiveSession` writes through.
 *     Exposed via `getSecondaryPage()` for the existing call sites
 *     in `app.tsx`, `sidebar.tsx`, and `secondary-page.tsx` that
 *     read it without caring about history.
 *
 * Browser invariants (the three operations):
 *   1. Navigate to a new page (`navigateTo` / `openSecondaryPage`):
 *      push current onto `back`, set `current = new`, clear `forward`.
 *   2. Back (`goBack` / Ctrl+[): push current onto `forward`, pop
 *      `back` into `current`.
 *   3. Forward (`goForward` / Ctrl+]): push current onto `back`, pop
 *      `forward` into `current`.
 *
 * Conversation (= no page open) is the implicit floor of `back` —
 * not a stack entry. Represented as `current === null`. The "don't
 * push null onto back" rule in `navigateTo` is what keeps the
 * stack from accumulating phantom conversation entries every time a
 * fresh page opens.
 *
 * Why arrays not single slots: today only one level deep is reachable
 * (no page-from-page navigation gesture exists), so the arrays will
 * have length 0 or 1 in practice. They are still arrays because the
 * data shape shouldn't lie about its semantics — if a future feature
 * ever lets the user navigate from page A to page B, it slots into
 * the existing model unchanged. See `docs/adr/0017`.
 *
 * Why sibling-module not agent-store: this is pure presentation-layer
 * navigation, not backend-event-driven state. The pattern mirrors
 * `prompt-draft.ts` precedent (per-session UI state living next to
 * the presentation container, not inside the reducer).
 *
 * Process-lifetime only: switching sessions within one Inkstone run
 * preserves each session's nav graph; quitting Inkstone discards
 * everything. Disk persistence is a separable additive feature.
 *
 * `createRoot` mirrors `secondary-page.ts` and `prompt-draft.ts` —
 * module-level signals need an owner so Solid doesn't warn about
 * dispose-orphaned computations and so the signals survive
 * back-to-back `renderApp()` calls inside the test harness.
 */

import { createRoot, createSignal, untrack } from "solid-js";
import type { SecondaryPageState } from "./secondary-page";

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

/** What is currently rendered (null = conversation visible). */
export function getSecondaryPage(): SecondaryPageState | null {
	return view();
}

/**
 * Notify history that the AgentProvider's session id changed. Called
 * from the layout-keybinds hook's session-id effect; that hook owns
 * the only reactive access to `SessionState.subscribeSessionId()`
 * inside the Layout's lifetime. Idempotent — same-sid calls no-op.
 *
 * Side effect: re-renders the view to whatever page the new session
 * had open (or conversation if it has no nav entry).
 */
export function setActiveSession(sid: string | null): void {
	// Read inside `untrack` because the only caller is a `createEffect`
	// in `use-layout-keybinds.ts` whose tracked dependency is the
	// session-id accessor. Tracking `state` here too would re-run the
	// effect every time `state` mutates (e.g. after navigateTo / goBack
	// / goForward, all of which write through `setState`). The re-run
	// would then write `state` again with the same sid, the early
	// return covers correctness — but Solid's batched scheduler still
	// surfaces the cycle as a stack overflow under load. `untrack`
	// breaks the cycle without changing observable behavior.
	untrack(() => {
		const s = state();
		if (s.sid === sid) return;
		setState({ ...s, sid });
		const nav = sid !== null ? s.map.get(sid) : undefined;
		setView(nav?.current ?? null);
	});
}

/** Browser rule 1 — open a page from the current position. */
export function navigateTo(page: SecondaryPageState): void {
	const s = state();
	if (s.sid === null) {
		// No session bound (pre-first-prompt or open-page surface).
		// Render directly without history; matches pre-history behavior
		// for the few call sites that hit this (test fixtures). Once a
		// session is active, every open routes through the per-session
		// stack.
		setView(page);
		return;
	}
	const cur = s.map.get(s.sid) ?? { back: [], current: null, forward: [] };
	const nextNav: SessionNav = {
		// Push current onto back ONLY when current isn't conversation
		// (null). Conversation is the implicit floor of the back stack,
		// not a stack entry — pushing null would let `goBack` pop a
		// phantom entry and leave `current === null && back.length === 0
		// && forward.length > 0` which `canGoBack` correctly reports as
		// false but the user would expect to be reachable.
		back: cur.current != null ? [...cur.back, cur.current] : [...cur.back],
		current: page,
		forward: [],
	};
	const nextMap = new Map(s.map);
	nextMap.set(s.sid, nextNav);
	setState({ ...s, map: nextMap });
	setView(page);
}

/** Browser rule 2 — step back. No-op if nowhere to go. */
export function goBack(): void {
	const s = state();
	if (s.sid === null) {
		// Open-page surface has no history; honour the back gesture as
		// "close anything that's open" so test fixtures and any future
		// pre-session overlay behave predictably.
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

/** Browser rule 3 — step forward. No-op if forward stack empty. */
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

/**
 * Reactive predicate: is there anywhere to step back to? Includes the
 * implicit conversation floor — when `current != null`, ctrl+[ closes
 * the page and returns to conversation, so the gesture is meaningful
 * even with an empty `back` stack.
 */
export function canGoBack(): boolean {
	const s = state();
	if (s.sid === null) return false;
	const nav = s.map.get(s.sid);
	if (!nav) return false;
	return nav.back.length > 0 || nav.current != null;
}

/** Reactive predicate: is there a forward entry to step into? */
export function canGoForward(): boolean {
	const s = state();
	if (s.sid === null) return false;
	const nav = s.map.get(s.sid);
	return nav ? nav.forward.length > 0 : false;
}

/**
 * Back-compat alias for `navigateTo`. Existing callers
 * (`file-part-handler.ts`, programmatic test setups) keep working
 * unchanged; the wrapper routes them through the per-session stack.
 */
export function openSecondaryPage(page: SecondaryPageState): void {
	navigateTo(page);
}

/**
 * Close the page AND wipe the current session's history. Intended for
 * `/clear` — the session is being destroyed so its nav graph must go
 * with it. `resume` does NOT call this (switching sessions preserves
 * history); the bridge effect handles view-sync on session change.
 *
 * The `afterEach` cleanup in TUI tests also calls this to reset
 * module-level state between back-to-back `renderApp` calls; wiping
 * the test's session history is desired since each test creates a
 * fresh session anyway.
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

/**
 * Test-only reset. Clears both signals so a leak from one test (e.g. a
 * dangling `current` or a forward stack) doesn't bleed into the next.
 * Mirrors `__resetDraftsForTesting` in `prompt-draft.ts`.
 */
export function __resetSecondaryPageHistoryForTesting(): void {
	setState({ map: new Map(), sid: null });
	setView(null);
}
