import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import open from "open";
import { type Accessor, Show } from "solid-js";
import { useTheme } from "../context/theme";
import * as Keybind from "../util/keybind";
import { type DialogContext, useDialog } from "./dialog";

/**
 * Open a URL in the OS default browser via the `open` package, which
 * handles per-platform launchers (macOS `open`, Linux `xdg-open`,
 * Windows via PowerShell/ShellExecute) and escapes metacharacters
 * correctly — AWS SSO URLs contain `&` which breaks naïve
 * `cmd /c start <url>` invocations. Matches OpenCode's `ui/link.tsx:3,22`.
 * Failures are swallowed; the URL stays visible so the user can copy it.
 */
function openInBrowser(url: string): void {
	open(url).catch(() => {});
}

/**
 * Wait-for-authorization dialog used during OAuth device-code flows
 * (e.g. Kiro Builder ID / IdC login).
 *
 * Trimmed port of OpenCode's `AutoMethod` block in
 * `component/dialog-provider.tsx:157-207`. We only need the display:
 *   - Bold title
 *   - Prominent clickable URL (primary color)
 *   - Instruction text (muted) — pi-kiro puts the user code here
 *   - Live progress line (muted) — driven by `onProgress` callback
 *   - Enter or mouse click on the URL opens it in the default browser
 *
 * No copy-to-clipboard, no manual code input, no SDK wiring — the caller
 * (DialogProvider's Kiro branch) owns the `loginKiro` callbacks and drives
 * the `progress` accessor. Cancel is the standard dialog-level esc/ctrl+c,
 * with `onCancel` fired by the dialog provider's `onClose` callback.
 */
export interface DialogAuthWaitProps {
	title: string;
	url: string;
	instructions?: string;
	progress?: Accessor<string>;
}

export function DialogAuthWait(props: DialogAuthWaitProps) {
	const dialog = useDialog();
	const { theme } = useTheme();

	// Enter opens the URL in the default browser. `select_submit` is
	// bound to `return` globally, so we reuse it here instead of defining
	// a dialog-local binding.
	useKeyboard((evt: any) => {
		if (evt.defaultPrevented) return;
		if (Keybind.match("select_submit", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			openInBrowser(props.url);
		}
	});

	return (
		<box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text attributes={TextAttributes.BOLD} fg={theme.text}>
					{props.title}
				</text>
				<text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
					esc
				</text>
			</box>
			<box gap={1}>
				<text fg={theme.primary} onMouseUp={() => openInBrowser(props.url)}>
					{props.url}
				</text>
				<Show when={props.instructions}>
					<text fg={theme.textMuted} wrapMode="word">
						{props.instructions}
					</text>
				</Show>
			</box>
			<Show when={props.progress}>
				<text fg={theme.textMuted}>{props.progress?.()}</text>
			</Show>
			<text fg={theme.text}>
				enter <span style={{ fg: theme.textMuted }}>open in browser</span>
			</text>
		</box>
	);
}

DialogAuthWait.show = (
	dialog: DialogContext,
	props: DialogAuthWaitProps,
	onClose?: () => void,
): void => {
	dialog.replace(() => <DialogAuthWait {...props} />, onClose);
};
