import { saveKiroCreds } from "@backend/persistence/auth";
import { getProvider } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loginKiro } from "pi-kiro/core";
import { createSignal } from "solid-js";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import { DialogAuthWait } from "../../../ui/dialog-auth-wait";
import { DialogPrompt } from "../../../ui/dialog-prompt";
import type { ToastContext } from "../../../ui/toast";
import { DialogModel } from "../model";

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
export async function startKiroLogin(
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
