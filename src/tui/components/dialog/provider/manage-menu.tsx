import type { ProviderInfo } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import {
	DialogSelect,
	type DialogSelectOption,
} from "../../../ui/dialog-select";
import type { ToastContext } from "../../../ui/toast";
import { confirmAndDisconnect } from "./confirm-and-disconnect";
import { LOGIN_FLOWS } from "./login-registry";

type ManageAction = "reconnect" | "disconnect";

/**
 * Secondary menu for a connected owned-creds provider: Reconnect or
 * Disconnect. Every shipped provider qualifies today: Kiro (OAuth),
 * ChatGPT / OpenAI Codex (OAuth), and OpenRouter (API key). A future
 * provider whose credentials Inkstone can't honestly clean up (e.g.
 * env-var-sourced) would need to short-circuit in `./index.tsx`
 * before reaching this menu — `DialogProvider` routes every connected
 * row here unconditionally.
 *
 * Reconnect delegates to the `LOGIN_FLOWS` lookup table — no pre-clear,
 * because login flows do not read existing creds and the save helpers
 * overwrite atomically on success. If the user ESCs mid-login, existing
 * creds remain intact (non-surprising).
 *
 * Disconnect routes through the shared `confirmAndDisconnect` helper:
 * DialogConfirm → `provider.clearCreds()` → `findFirstConnectedProvider`
 * rehome → toast. Per-provider logic is entirely in `clearCreds()`
 * (credential wipe) + `displayName` (toast strings).
 */
export function showManageMenu(
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	primaryColor: ReturnType<typeof useTheme>["theme"]["primary"],
	provider: ProviderInfo,
	onModelSelected: (model: Model<Api>) => void,
	activeProviderId: string | undefined,
): void {
	const opts: DialogSelectOption<ManageAction>[] = [
		{
			title: "Reconnect",
			value: "reconnect",
			description: "Sign in again",
		},
		{
			title: "Disconnect",
			value: "disconnect",
			description: "Remove stored credentials",
		},
	];
	dialog.replace(() => (
		<DialogSelect
			title={provider.displayName}
			options={opts}
			// Load-bearing: both onSelect branches need to keep the dialog
			// stack occupied while they `dialog.replace` into the next
			// dialog (login prompt or confirm). Without this, DialogSelect
			// would `dialog.clear()` on select and race the replacement.
			closeOnSelect={false}
			onSelect={(option) => {
				if (option.value === "reconnect") {
					const login = LOGIN_FLOWS[provider.id];
					if (login) {
						void login(
							dialog,
							toast,
							mutedColor,
							primaryColor,
							onModelSelected,
						);
					}
					return;
				}
				void confirmAndDisconnect(
					dialog,
					toast,
					provider,
					onModelSelected,
					activeProviderId,
				);
			}}
		/>
	));
}
