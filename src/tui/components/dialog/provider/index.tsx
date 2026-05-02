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
import { startOpenAICodexLogin } from "./login-openai-codex";
import { showManageMenu } from "./manage-menu";
import { setOpenRouterKey } from "./set-openrouter-key";

interface ProviderValue {
	id: string;
}

/**
 * Set of provider ids whose credentials Inkstone owns (stored in
 * `~/.config/inkstone/auth.json`). Selecting a connected row for one of
 * these providers opens the Reconnect/Disconnect manage menu; selecting
 * a disconnected row routes to the provider's login flow. Every provider
 * in the registry is in this set today — the explicit allowlist is a
 * defensive gate so a future non-owned-creds provider (e.g. one that
 * reads creds from an env var Inkstone can't clean up) can be added to
 * the registry without accidentally exposing a Disconnect action it
 * can't honestly perform. PR #2 deletes this set along with the
 * `authInstructions` fallback-toast branch when `ProviderInfo.login`
 * becomes the uniform entry point.
 */
const OWNED_CREDS_PROVIDERS = new Set(["kiro", "openai-codex", "openrouter"]);

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider in `OWNED_CREDS_PROVIDERS` opens a secondary
 * Reconnect / Disconnect menu (see `./manage-menu`). Any other connected
 * provider is a no-op dismiss — today every shipped provider is in the
 * set, so this branch is dead code that PR #2 removes.
 *
 * Selecting a *disconnected* provider:
 *   - `kiro` → launches the OAuth device-code flow (see `./login-kiro`).
 *   - `openai-codex` → launches the PKCE authorization-code flow (see
 *     `./login-openai-codex`).
 *   - `openrouter` → opens a single DialogPrompt for API-key paste
 *     (see `./set-openrouter-key`).
 *   - no match → toast with `authInstructions`. Dead branch today;
 *     PR #2 deletes it when `authInstructions` is removed from the
 *     `ProviderInfo` interface.
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
					// Owned-creds providers (all three shipped today) open
					// the reconnect/disconnect menu. Any provider outside
					// `OWNED_CREDS_PROVIDERS` dismisses silently — dead
					// branch today; PR #2 deletes the gate along with the
					// set itself.
					if (OWNED_CREDS_PROVIDERS.has(provider.id)) {
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
				if (provider.id === "openai-codex") {
					void startOpenAICodexLogin(
						dialog,
						toast,
						theme.textMuted,
						props.onModelSelected,
					);
					return;
				}
				if (provider.id === "openrouter") {
					void setOpenRouterKey(
						dialog,
						toast,
						theme.textMuted,
						theme.primary,
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
