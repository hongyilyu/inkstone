/**
 * Layout-level `useKeyboard` handler. Lives here (not in the command
 * registry) because these bindings don't fit the registry's model:
 *
 *   - `app_exit` destroys the renderer (not a normal "command").
 *   - `secondary_page_close` is gated on the secondary-page being
 *     open — no natural palette entry.
 *   - scroll keys target a layout-local ref (`scroll`) that's only
 *     meaningful when the session view is mounted.
 *
 * Also hosts the `setActiveSession(sid)` bridge for the secondary
 * page; see `docs/ARCHITECTURE.md` § Per-session secondary page.
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
	closeSecondaryPage,
	getSecondaryPage,
	setActiveSession,
} from "../context/secondary-page";
import { useDialog } from "../ui/dialog";
import * as Keybind from "../util/keybind";

export function useLayoutKeybinds(): void {
	const renderer = useRenderer();
	const dialog = useDialog();
	const layout = useLayout();
	const { session } = useAgent();

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

		// ESC / Ctrl+[ — close secondary page and return to
		// conversation. Checked after app_exit but before scroll
		// guards. Gated on no open dialogs so ESC closes a dialog
		// first when one is on the stack.
		if (
			Keybind.match("secondary_page_close", evt) &&
			getSecondaryPage() &&
			dialog.stack.length === 0
		) {
			closeSecondaryPage();
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
