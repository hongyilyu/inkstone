import { listProviders } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import { useTheme } from "../../../context/theme";
import { type DialogContext, useDialog } from "../../../ui/dialog";
import {
	DialogSelect,
	type DialogSelectOption,
} from "../../../ui/dialog-select";
import { useToast } from "../../../ui/toast";
import { startKiroLogin } from "./login-kiro";
import { showManageMenu } from "./manage-menu";

interface ProviderValue {
	id: string;
}

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider that Inkstone owns credentials for (currently Kiro)
 * opens a secondary Reconnect / Disconnect menu (see `./manage-menu`).
 * Selecting any other connected provider (Bedrock — creds live in
 * `~/.aws/` or AWS_* env vars, not ours to touch) is a no-op dismiss.
 *
 * Selecting a *disconnected* provider:
 *   - `kiro` → launches the OAuth device-code flow (see `./login-kiro`).
 *   - others (currently just Bedrock) → toast with `authInstructions`
 *     so the user knows which env vars to set.
 *
 * The companion Models dialog lists only models from connected providers,
 * so this dialog is the gateway for making new providers usable.
 */
export function DialogProvider(props: {
	onModelSelected: (model: Model<Api>) => void;
	/**
	 * Provider id of the session's currently-active model, if any. When the
	 * user disconnects this exact provider, the dialog rehomes the session
	 * onto `DEFAULT_PROVIDER`'s default model (if connected) so the next
	 * prompt doesn't hit a 401. Optional so tests and any future caller
	 * without a session handle can omit it — the rehome branch no-ops.
	 *
	 * Captured at dialog-open time, not re-read at disconnect-confirm time.
	 * Sound today because every dialog blocks global keybinds while open
	 * (see `CommandProvider` suspend in `../command.tsx`), so the active
	 * model cannot drift between open and confirm. If a future flow lets
	 * a dialog-internal action change the active model, thread a
	 * `() => string` getter instead.
	 */
	activeProviderId?: string;
}) {
	const toast = useToast();
	const dialog = useDialog();
	const { theme } = useTheme();

	const options = createMemo<DialogSelectOption<ProviderValue>[]>(() => {
		// Connected providers float to the top so the current state is
		// obvious at a glance.
		const all = [...listProviders()].sort(
			(a, b) => Number(b.isConnected()) - Number(a.isConnected()),
		);
		return all.map((p) => ({
			title: p.displayName,
			value: { id: p.id },
			// Connected providers surface their state via a green `✓`
			// gutter; disconnected providers render with an empty
			// gutter and no description text. Connection status is
			// now glyph-plus-color — the muted `Not configured`
			// string is redundant once the sort puts unconnected rows
			// last.
			gutter: p.isConnected() ? <text fg={theme.success}>✓</text> : undefined,
		}));
	});

	return (
		<DialogSelect
			title="Providers"
			placeholder="Search providers..."
			options={options()}
			closeOnSelect={false}
			onSelect={(option) => {
				const provider = listProviders().find((p) => p.id === option.value.id);
				if (!provider) return;
				if (provider.isConnected()) {
					// Kiro creds live in `~/.config/inkstone/auth.json` so we
					// can honestly disconnect / re-auth. Bedrock creds live
					// outside Inkstone (~/.aws/, AWS_* env vars), so there's
					// nothing here to manage — dismiss.
					if (provider.id === "kiro") {
						showManageMenu(
							dialog,
							toast,
							theme.textMuted,
							provider,
							props.onModelSelected,
							props.activeProviderId,
						);
						return;
					}
					dialog.clear();
					return;
				}
				if (provider.id === "kiro") {
					// The login flow reuses the same dialog stack via `dialog.replace`,
					// so only one dialog is on the stack at any time.
					void startKiroLogin(
						dialog,
						toast,
						theme.textMuted,
						props.onModelSelected,
					);
					return;
				}
				toast.show({
					variant: "warning",
					message: `${provider.displayName}: ${provider.authInstructions}`,
				});
			}}
		/>
	);
}

DialogProvider.show = (
	dialog: DialogContext,
	onModelSelected: (model: Model<Api>) => void,
	activeProviderId?: string,
) => {
	dialog.replace(() => (
		<DialogProvider
			onModelSelected={onModelSelected}
			activeProviderId={activeProviderId}
		/>
	));
};
