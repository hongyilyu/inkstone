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
import { LOGIN_FLOWS } from "./login-registry";
import { showManageMenu } from "./manage-menu";

interface ProviderValue {
	id: string;
}

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider opens the Reconnect / Disconnect manage menu (see
 * `./manage-menu`). Every shipped provider is an owned-creds provider —
 * their credentials live in `~/.config/inkstone/auth.json` and
 * `ProviderInfo.clearCreds()` owns the wipe.
 *
 * Selecting a *disconnected* provider dispatches through the
 * `LOGIN_FLOWS` lookup table (see `./login-registry`). Today every
 * shipped provider has an entry there. `undefined` would be a
 * programming error (a provider was added to the registry without a
 * login flow) — no user-facing path. No fallback toast: if a future
 * provider ever lacks a login flow, the user sees nothing happen,
 * which is the correct signal that the provider isn't usable yet.
 *
 * The companion Models dialog lists only models from connected providers,
 * so this dialog is the gateway for making new providers usable.
 */
export function DialogProvider(props: {
	onModelSelected: (model: Model<Api>) => void;
	/**
	 * Provider id of the session's currently-active model, if any. When the
	 * user disconnects this exact provider, the dialog rehomes the session
	 * onto the first other connected provider's default model (via
	 * `findFirstConnectedProvider`) so the next prompt doesn't hit a 401.
	 * Optional so tests and any future caller without a session handle can
	 * omit it — the rehome branch no-ops.
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
					showManageMenu(
						dialog,
						toast,
						theme.textMuted,
						theme.primary,
						provider,
						props.onModelSelected,
						props.activeProviderId,
					);
					return;
				}
				const login = LOGIN_FLOWS[provider.id];
				if (login) {
					void login(
						dialog,
						toast,
						theme.textMuted,
						theme.primary,
						props.onModelSelected,
					);
				}
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
