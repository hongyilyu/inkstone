/**
 * `LayoutContext` — central registry for layout-level handles
 * (scroll container, prompt textarea) that consumers outside the JSX
 * tree need to drive imperatively.
 *
 * Why a context instead of module-scoped lets in `app.tsx`?
 *
 *   - Solid's lifecycle owns mount/unmount; module-scoped state
 *     forces every ref callback to do an `onCleanup` identity-check
 *     to avoid leaking handles past their owner.
 *   - Tests want a clean reset boundary — re-rendering the harness
 *     should not retain the previous render's refs.
 *   - The action / reducer layer should not import layout primitives
 *     directly. Threading via context turns "TUI app module exports
 *     a side effect" into "the provider exposes a typed surface."
 *
 * Migration plan (Stack C):
 *   - C1: this file lands, `LayoutProvider` becomes the source of
 *     truth for scroll. `app.tsx` keeps the module-level shims
 *     (`scrollRef`, `setScrollRef`, `clearScrollRef`, `toBottom`)
 *     but they now proxy through `activeLayout` so existing imports
 *     work unchanged.
 *   - C2: extend the context with input refs; migrate all
 *     component-level call sites to `useLayout()`. Shims remain.
 *   - C3: delete the shims. Lint catches any straggling import.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import {
	createContext,
	onCleanup,
	type ParentProps,
	useContext,
} from "solid-js";

/**
 * Type alias for the prompt textarea ref. OpenTUI's `InputRenderable`
 * isn't exported on the type surface we use elsewhere, so this stays
 * `any` and consumers narrow at the call site (every existing caller
 * already does — `input.isDestroyed`, `input.focus()`, etc.).
 */
type InputRef = any;

export interface LayoutContextValue {
	/** Register the conversation scrollbox (called from its ref callback). */
	setScrollRef(ref: ScrollBoxRenderable): void;
	/**
	 * Clear the registered scrollbox if `ref` matches. Identity check
	 * guards against a late cleanup from a previous mount clobbering a
	 * fresh mount's ref.
	 */
	clearScrollRef(ref: ScrollBoxRenderable): void;
	/**
	 * Read the current scrollbox handle. Returns null when not mounted
	 * or when the box has been destroyed (callers should re-check
	 * `isDestroyed` before issuing scroll calls).
	 */
	getScroll(): ScrollBoxRenderable | null;
	/**
	 * Scroll the conversation to the bottom. Defers via `setTimeout`
	 * so the next paint sees the just-pushed bubble before scrolling.
	 * No-op when there's no live scrollbox (pre-mount, post-unmount).
	 */
	scrollToBottom(): void;

	// ── Input surface ────────────────────────────────────────
	/** Register the prompt textarea (called from its ref callback). */
	setInputRef(ref: InputRef): void;
	/** Clear the registered input if `ref` matches (identity-guarded). */
	clearInputRef(ref: InputRef): void;
	/** Read the current input handle. */
	getInputRef(): InputRef;
	/**
	 * Focus the prompt if it's mounted, alive, and not already focused.
	 * Used after dialog/panel dismiss so keyboard input lands in the
	 * textarea again.
	 */
	focusInput(): void;
	/**
	 * Blur the prompt if it's mounted, alive, and currently focused.
	 * Paired with `focusInput()` — the session list panel calls this
	 * on open so arrows/Enter route to the panel, not the textarea.
	 */
	blurInput(): void;
}

const layoutContext = createContext<LayoutContextValue | null>(null);

/**
 * Module-scoped pointer to the currently-mounted `LayoutProvider`.
 * Used ONLY by the deprecated `app.tsx` shim functions during the
 * Stack C migration. Components and reducers should call
 * `useLayout()` instead.
 */
let activeLayout: LayoutContextValue | null = null;

export function getActiveLayout(): LayoutContextValue | null {
	return activeLayout;
}

export function LayoutProvider(props: ParentProps): unknown {
	let scroll: ScrollBoxRenderable | null = null;
	let input: InputRef = null;

	const value: LayoutContextValue = {
		setScrollRef(ref) {
			scroll = ref;
		},
		clearScrollRef(ref) {
			if (scroll === ref) scroll = null;
		},
		getScroll() {
			return scroll;
		},
		scrollToBottom() {
			setTimeout(() => {
				if (!scroll || scroll.isDestroyed) return;
				scroll.scrollTo(scroll.scrollHeight);
			}, 50);
		},
		setInputRef(ref) {
			input = ref;
		},
		clearInputRef(ref) {
			if (input === ref) input = null;
		},
		getInputRef() {
			return input;
		},
		focusInput() {
			if (input && !input.isDestroyed && !input.focused) input.focus();
		},
		blurInput() {
			if (input && !input.isDestroyed && input.focused) input.blur();
		},
	};

	activeLayout = value;
	onCleanup(() => {
		if (activeLayout === value) activeLayout = null;
	});

	return (
		<layoutContext.Provider value={value}>
			{props.children}
		</layoutContext.Provider>
	);
}

export function useLayout(): LayoutContextValue {
	const v = useContext(layoutContext);
	if (!v) throw new Error("useLayout must be used within a LayoutProvider");
	return v;
}
