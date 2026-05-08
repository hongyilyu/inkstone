/**
 * `LayoutContext` — central registry for layout-level imperative
 * handles (scroll container, prompt textarea, Ctrl+C bridge) that
 * components and provider-scoped action handlers need to drive.
 *
 * Design rationale + provider ordering + Ctrl+C bridge contract are
 * documented in `docs/LAYOUT-CONTEXT.md`.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { createContext, type ParentProps, useContext } from "solid-js";

// `any` because OpenTUI's `InputRenderable` isn't exported on the type
// surface we use elsewhere; consumers narrow at the call site.
type InputRef = any;

/**
 * Two-stage Ctrl+C decision callbacks the Prompt publishes on mount.
 * See `docs/LAYOUT-CONTEXT.md` § PromptCtrlCBridge for why the bridge
 * pattern is required (mount-order coupling with `useLayoutKeybinds`).
 */
export interface PromptCtrlCBridge {
	decide: () => "clear" | "arm" | "fall_through";
	clear: () => void;
	arm: () => void;
	disarm: () => void;
}

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

	// ── Ctrl+C bridge ────────────────────────────────────────
	/**
	 * Publish the prompt's Ctrl+C decision callbacks. Called from
	 * `Prompt`'s setup; the matching `setCtrlCBridge(null)` lives in
	 * its `onCleanup`.
	 */
	setCtrlCBridge(bridge: PromptCtrlCBridge | null): void;
	/**
	 * Read the current Ctrl+C bridge. Returns null when the prompt
	 * isn't mounted — the layout handler then falls back to immediate
	 * exit (boot fallback, approval / suggestion panel surfaces).
	 */
	getCtrlCBridge(): PromptCtrlCBridge | null;
}

const layoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider(props: ParentProps): unknown {
	let scroll: ScrollBoxRenderable | null = null;
	let input: InputRef = null;
	let ctrlCBridge: PromptCtrlCBridge | null = null;

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
		setCtrlCBridge(bridge) {
			ctrlCBridge = bridge;
		},
		getCtrlCBridge() {
			return ctrlCBridge;
		},
	};

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
