import type { ProviderInfo } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import {
	DialogSelect,
	type DialogSelectOption,
} from "../../../ui/dialog-select";
import type { ToastContext } from "../../../ui/toast";
import { confirmAndDisconnectKiro } from "./disconnect-kiro";
import { startKiroLogin } from "./login-kiro";

type ManageAction = "reconnect" | "disconnect";

/**
 * Secondary menu for a connected Kiro provider: Reconnect or Disconnect.
 *
 * Reconnect delegates to the same `startKiroLogin` the disconnected-select
 * branch uses — no pre-clear, because `loginKiro` does not read existing
 * creds and `saveKiroCreds` overwrites atomically on success. If the user
 * ESCs mid-login, existing creds remain intact (non-surprising).
 *
 * Disconnect confirms first (destructive guard), then clears creds and
 * rehomes the active session if Kiro was the one in use. See
 * `confirmAndDisconnectKiro` for the rehome logic.
 *
 * Kiro-specific on purpose: only Kiro's creds live in Inkstone storage
 * (`~/.config/inkstone/auth.json`). Bedrock creds are outside our remit
 * (~/.aws/ + AWS_* env vars), so no management menu for Bedrock.
 */
export function showManageMenu(
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
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
					void startKiroLogin(dialog, toast, mutedColor, onModelSelected);
					return;
				}
				void confirmAndDisconnectKiro(
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
