import { saveKiroCreds } from "@backend/persistence/auth";
import { getProvider, listProviders } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loginKiro } from "pi-kiro/core";
import { createMemo, createSignal } from "solid-js";
import { useTheme } from "../context/theme";
import { type DialogContext, useDialog } from "../ui/dialog";
import { DialogAuthWait } from "../ui/dialog-auth-wait";
import { DialogPrompt } from "../ui/dialog-prompt";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import { type ToastContext, useToast } from "../ui/toast";
import { DialogModel } from "./dialog-model";

interface ProviderValue {
	id: string;
}

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider is a no-op (closes the dialog) — manage/disconnect
 * actions land when a second provider exists and the flow can be exercised.
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
					// No management actions yet — dismiss. Reserved for future
					// disconnect / re-auth flows.
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
) => {
	dialog.replace(() => <DialogProvider onModelSelected={onModelSelected} />);
};

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
