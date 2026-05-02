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
import { confirmAndDisconnectOpenAICodex } from "./disconnect-openai-codex";
import { startKiroLogin } from "./login-kiro";
import { startOpenAICodexLogin } from "./login-openai-codex";

type ManageAction = "reconnect" | "disconnect";

/**
 * Secondary menu for a connected owned-creds provider: Reconnect or
 * Disconnect. Today that's Kiro and ChatGPT (OpenAI Codex). Bedrock's
 * creds live outside Inkstone (~/.aws/ + AWS_* env vars), so there's
 * nothing for us to manage for that provider and it short-circuits
 * back in `./index.tsx`.
 *
 * Reconnect delegates to the same login helpers the disconnected-select
 * branch uses — no pre-clear, because the login flows do not read
 * existing creds and the save helpers overwrite atomically on success.
 * If the user ESCs mid-login, existing creds remain intact
 * (non-surprising).
 *
 * Disconnect confirms first (destructive guard), then clears creds and
 * rehomes the active session if the disconnected provider was the one
 * in use. See the respective `confirmAndDisconnect…` for the rehome
 * logic.
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
					if (provider.id === "kiro") {
						void startKiroLogin(dialog, toast, mutedColor, onModelSelected);
					} else if (provider.id === "openai-codex") {
						void startOpenAICodexLogin(
							dialog,
							toast,
							mutedColor,
							onModelSelected,
						);
					}
					return;
				}
				if (provider.id === "kiro") {
					void confirmAndDisconnectKiro(
						dialog,
						toast,
						provider,
						onModelSelected,
						activeProviderId,
					);
				} else if (provider.id === "openai-codex") {
					void confirmAndDisconnectOpenAICodex(
						dialog,
						toast,
						provider,
						onModelSelected,
						activeProviderId,
					);
				}
			}}
		/>
	));
}
