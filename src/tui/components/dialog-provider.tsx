import { clearKiroCreds, saveKiroCreds } from "@backend/persistence/auth";
import {
	DEFAULT_PROVIDER,
	getProvider,
	listProviders,
	type ProviderInfo,
	resolveModel,
} from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loginKiro } from "pi-kiro/core";
import { createMemo, createSignal } from "solid-js";
import { useTheme } from "../context/theme";
import { type DialogContext, useDialog } from "../ui/dialog";
import { DialogAuthWait } from "../ui/dialog-auth-wait";
import { DialogConfirm } from "../ui/dialog-confirm";
import { DialogPrompt } from "../ui/dialog-prompt";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import { type ToastContext, useToast } from "../ui/toast";
import { DialogModel } from "./dialog-model";

interface ProviderValue {
	id: string;
}

type ManageAction = "reconnect" | "disconnect";

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider that Inkstone owns credentials for (currently Kiro)
 * opens a secondary Reconnect / Disconnect menu. Selecting any other
 * connected provider (Bedrock — creds live in `~/.aws/` or AWS_* env vars,
 * not ours to touch) is a no-op dismiss.
 *
 * Selecting a *disconnected* provider:
 *   - `kiro` → launches the OAuth device-code flow (see `startKiroLogin`).
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
	 * (see `CommandProvider` suspend in `dialog-command.tsx`), so the
	 * active model cannot drift between open and confirm. If a future
	 * flow lets a dialog-internal action change the active model, thread
	 * a `() => string` getter instead.
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
			description: p.isConnected() ? "✓ Connected" : "Not configured",
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
function showManageMenu(
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

/**
 * Confirm-then-disconnect for Kiro.
 *
 * If the active session is pointing at Kiro, rehome it onto
 * `DEFAULT_PROVIDER`'s default model — but only when that provider is
 * itself connected. Mirrors the boot-time fallback in
 * `resolveInitialProviderModel` (`src/backend/agent/index.ts`): an
 * OAuth provider whose creds expired shouldn't wedge the app on a
 * 401-every-prompt path when a working alternative is one call away.
 *
 * Rehome goes through the same `onModelSelected` prop the connected-flow
 * calls, which is wired to `actions.setModel` at the palette caller. No
 * dedicated setModel handle needed here.
 *
 * Kiro-specific: calls `clearKiroCreds()` directly. When a second
 * owned-creds provider arrives, widen this to `provider.clearCreds?.()`
 * (after adding the optional hook to `ProviderInfo`) — deferred per the
 * no-speculative-capability-flag trade-off.
 */
async function confirmAndDisconnectKiro(
	dialog: DialogContext,
	toast: ToastContext,
	provider: ProviderInfo,
	onModelSelected: (model: Model<Api>) => void,
	activeProviderId: string | undefined,
): Promise<void> {
	const confirmed = await DialogConfirm.show(
		dialog,
		`Disconnect ${provider.displayName}?`,
		"Stored credentials will be removed from this device. You can reconnect anytime from this dialog.",
	);
	// `DialogConfirm.show` resolves `true` on confirm, `false` on cancel,
	// `undefined` on ESC. Only proceed on explicit confirm.
	if (confirmed !== true) return;

	clearKiroCreds();

	let rehomed = false;
	if (activeProviderId === provider.id) {
		const fallback = getProvider(DEFAULT_PROVIDER);
		if (fallback.id !== provider.id && fallback.isConnected()) {
			const model = resolveModel(fallback.id, fallback.defaultModelId);
			if (model) {
				onModelSelected(model);
				rehomed = true;
			}
		}
	}

	if (activeProviderId === provider.id && !rehomed) {
		toast.show({
			variant: "warning",
			message: `${provider.displayName} disconnected. Pick a new model from /models before your next prompt.`,
		});
	} else {
		toast.show({
			variant: "success",
			message: `${provider.displayName} disconnected.`,
		});
	}
}

/**
 * Drive pi-kiro's `loginKiro` callbacks against the dialog stack.
 *
 * The pi-kiro flow may call `onPrompt` up to twice (start URL, optional
 * IdC region) before calling `onAuth`. Each call replaces the current
 * dialog via `DialogPrompt.show`, so only one dialog is ever on the stack
 * and the mirrored-cursor glitch noted in pi-kiro's `oauth.ts:16-23`
 * (two widgets appended to the same container) can't happen here.
 *
 * Cancellation: any stack-close (ESC or ctrl+c) resolves the prompt
 * promise to `null`, which we translate into an abort on the controller
 * passed to `loginKiro`. That unwinds `loginKiro` with "Login cancelled"
 * which we swallow silently.
 */
async function startKiroLogin(
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	onModelSelected: (model: Model<Api>) => void,
): Promise<void> {
	const controller = new AbortController();
	const [progress, setProgress] = createSignal("");

	try {
		const creds = await loginKiro({
			async onPrompt({ message, placeholder, allowEmpty }) {
				const value = await DialogPrompt.show(dialog, {
					title: "Sign in to Amazon Kiro",
					description: () => <text fg={mutedColor}>{message}</text>,
					placeholder,
					allowEmpty,
				});
				if (value === null) {
					// User cancelled. Throwing here unwinds `loginKiro`
					// synchronously before any network calls fire (pi-kiro
					// `core.js:146-163` does not wrap this `await onPrompt`).
					// Returning `""` instead would let the Builder ID branch
					// run and POST to AWS SSO-OIDC before the signal observes
					// the abort — leaking a real client registration + a
					// flashed auth dialog for a cancelled flow.
					controller.abort();
					throw new Error("Login cancelled");
				}
				return value;
			},
			onAuth({ url, instructions }) {
				DialogAuthWait.show(
					dialog,
					{
						title: "Authorize Amazon Kiro",
						url,
						instructions,
						progress,
					},
					() => controller.abort(),
				);
			},
			onProgress(msg) {
				setProgress(msg);
			},
			signal: controller.signal,
		});

		saveKiroCreds(creds);
		dialog.clear();
		toast.show({
			variant: "success",
			message: "Amazon Kiro connected.",
		});
		// Drop the user straight into the Kiro model picker so they can
		// immediately pick a model from the freshly-available catalog.
		// Mirrors OpenCode's chain in `component/dialog-provider.tsx:183-184`.
		const kiroProvider = getProvider("kiro");
		DialogModel.show(
			dialog,
			{
				providerId: "kiro",
				modelId: kiroProvider.defaultModelId,
			},
			onModelSelected,
		);
	} catch (err) {
		if (controller.signal.aborted) {
			// Silent cancel. This branch specifically covers user-initiated
			// ESC: we abort the controller in `onPrompt`/`onAuth`'s onClose.
			// Provider-side errors that happen to include "cancel" in the
			// message (none currently documented in pi-kiro — `core.js:99`
			// and `:105` only throw on signal abort) would fall through to
			// the else branch as a regular error toast, which is the right
			// surface for any non-user-driven failure.
			dialog.clear();
			return;
		}
		dialog.clear();
		toast.show({
			variant: "error",
			message: `Kiro login failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
}
