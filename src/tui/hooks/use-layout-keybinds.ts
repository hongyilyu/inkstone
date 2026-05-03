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
import { scrollRef } from "../app";
import {
	closeSecondaryPage,
	getSecondaryPage,
} from "../context/secondary-page";
import { useDialog } from "../ui/dialog";
import * as Keybind from "../util/keybind";

export function useLayoutKeybinds(): void {
	const renderer = useRenderer();
	const dialog = useDialog();

	useKeyboard((evt: any) => {
		if (evt.defaultPrevented) return;

		if (Keybind.match("app_exit", evt)) {
			// Only exit when no dialog is open — otherwise the dialog
			// stack's handler in `ui/dialog.tsx` treats ctrl+c as "close
			// dialog".
			if (dialog.stack.length > 0) return;
			renderer.destroy();
			// renderer.destroy() restores terminal state; exit the
			// process since pi-agent-core keeps handles alive.
			setTimeout(() => process.exit(0), 100);
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

		const scroll = scrollRef();
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
