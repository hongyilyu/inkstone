/**
 * Layout-level `useKeyboard` handler. Lives here (not in the command
 * registry) because these bindings don't fit the registry's model:
 *
 *   - `app_exit` destroys the renderer (not a normal "command").
 *   - `secondary_page_close` / `secondary_page_forward` are gated on
 *     per-session `canGoBack` / `canGoForward` predicates from
 *     `secondary-page-history.ts` — no natural palette entry.
 *   - scroll keys target a layout-local ref (`scroll`) that's only
 *     meaningful when the session view is mounted.
 *
 * The hook also owns the `setActiveSession(sid)` bridge: a small
 * effect tracks `session.subscribeSessionId()` and forwards each
 * change into the history module so the rendered page swaps to the
 * new session's `current` (browser-tab semantics). Mounted at layout
 * level — same lifetime as the AgentProvider — so the bridge stays
 * up across every navigation surface this hook owns keybinds for.
 *
 * Gains a `defaultPrevented` guard at the top that matches the
 * patterns in `dialog.tsx` and `command.tsx` — stops nested consumers
 * that already handled the event from cascading into the Layout's
 * scroll / exit bindings. The existing `dialog.stack.length > 0`
 * guard further down already covers the "dialog open → skip scroll
 * keys" case, but the new guard closes the narrower window where a
 * focused child `preventDefault`s an event that isn't dialog-scoped
 * (e.g. `secondary_page_close` dispatched to a nested handler).
 */

import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect } from "solid-js";
import { useAgent } from "../context/agent";
import { useLayout } from "../context/layout";
import {
	canGoBack,
	canGoForward,
	goBack,
	goForward,
	setActiveSession,
} from "../context/secondary-page-history";
import { useDialog } from "../ui/dialog";
import * as Keybind from "../util/keybind";

export function useLayoutKeybinds(): void {
	const renderer = useRenderer();
	const dialog = useDialog();
	const layout = useLayout();
	const { session } = useAgent();

	// Forward session-id changes into the history module so its derived
	// `view` signal swaps to the new session's `current`. Resume swaps
	// the id underneath us via the `batch()` in `actions/resume.ts:61`,
	// so the effect re-runs after the batch flushes and the history
	// view re-renders to whatever page that session was on (or
	// conversation if it has no entry). Same lifetime contract as the
	// `<PromptDraftBridge>`'s subscribeSessionId consumption.
	const sessionIdAccessor = session.subscribeSessionId();
	createEffect(() => {
		setActiveSession(sessionIdAccessor());
	});

	function exitNow() {
		renderer.destroy();
		// renderer.destroy() restores terminal state; exit the
		// process since pi-agent-core keeps handles alive.
		setTimeout(() => process.exit(0), 100);
	}

	useKeyboard((evt: any) => {
		if (evt.defaultPrevented) return;

		if (Keybind.match("app_exit", evt)) {
			// Only exit when no dialog is open — otherwise the dialog
			// stack's handler in `ui/dialog.tsx` treats ctrl+c as "close
			// dialog".
			if (dialog.stack.length > 0) return;
			// Two-stage Ctrl+C when the prompt is mounted: press 1 with
			// text clears; press 1 on empty arms a 5s "again to exit"
			// hint; press 2 within the window exits. When the prompt
			// isn't mounted (no-provider boot, approval / suggestion
			// panels) the bridge is null and we exit immediately —
			// matches today's behavior on those surfaces. Owns the
			// single `useKeyboard` registration for `app_exit` because
			// OpenTUI dispatches global listeners in registration order
			// and any prompt-level handler would fire after this one.
			const bridge = layout.getCtrlCBridge();
			if (bridge) {
				const action = bridge.decide();
				if (action === "clear") {
					bridge.clear();
					evt.preventDefault();
					return;
				}
				if (action === "arm") {
					bridge.arm();
					evt.preventDefault();
					return;
				}
				bridge.disarm();
			}
			exitNow();
			return;
		}

		// ESC / Ctrl+[ — step back through the secondary-page history.
		// `canGoBack` is true while a page is on screen (closing it to
		// conversation is one step back) OR while a back-stack entry
		// remains (page-from-page nav, not reachable today but the
		// data shape supports it). Gated on no open dialogs so ESC
		// closes a dialog first when one is on the stack.
		if (
			Keybind.match("secondary_page_close", evt) &&
			canGoBack() &&
			dialog.stack.length === 0
		) {
			goBack();
			return;
		}

		// Ctrl+] — step forward. Meaningful from BOTH the conversation
		// root (forward stack populated by a prior ctrl+[) and from
		// inside an open page (page-from-page forward, not reachable
		// today). Same dialog gate as back.
		if (
			Keybind.match("secondary_page_forward", evt) &&
			canGoForward() &&
			dialog.stack.length === 0
		) {
			goForward();
			return;
		}

		const scroll = layout.getScroll();
		if (!scroll || scroll.isDestroyed) return;
		if (dialog.stack.length > 0) return;

		if (Keybind.match("messages_page_up", evt)) {
			scroll.scrollBy(-scroll.height / 2);
			return;
		}
		if (Keybind.match("messages_page_down", evt)) {
			scroll.scrollBy(scroll.height / 2);
			return;
		}
		if (Keybind.match("messages_first", evt)) {
			scroll.scrollTo(0);
			return;
		}
		if (Keybind.match("messages_last", evt)) {
			scroll.scrollTo(scroll.scrollHeight);
			return;
		}
	});
}
