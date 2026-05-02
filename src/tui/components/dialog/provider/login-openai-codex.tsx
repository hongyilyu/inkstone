import { saveOpenAICodexCreds } from "@backend/persistence/auth";
import { getProvider } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { createSignal } from "solid-js";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import { DialogAuthWait } from "../../../ui/dialog-auth-wait";
import { DialogPrompt } from "../../../ui/dialog-prompt";
import type { ToastContext } from "../../../ui/toast";
import { DialogModel } from "../model";

/**
 * Drive pi-ai's `loginOpenAICodex` callbacks against the dialog stack.
 *
 * The flow differs from Kiro (AWS SSO-OIDC device-code) — pi-ai's Codex
 * OAuth is PKCE authorization-code with a local HTTP callback on
 * `127.0.0.1:1455`. pi-ai's `loginOpenAICodex` emits callbacks in this
 * order (see `pi-ai/utils/oauth/openai-codex.js:244-335`):
 *
 * 1. `onAuth({ url, instructions })` — fires right after the local
 *    server is bound. We render `DialogAuthWait` with a clickable URL.
 *
 * 2. `waitForCode()` — pi-ai waits for the browser to hit
 *    `http://127.0.0.1:1455/auth/callback`. Success path: user
 *    completes login in the browser, code comes back in, pi-ai
 *    exchanges it for a token and returns.
 *
 * 3. `onPrompt(prompt)` — fires as a post-failure fallback:
 *    when `startLocalOAuthServer` couldn't bind to 1455 (port busy
 *    / firewall), or the callback never came through. We show
 *    a `DialogPrompt` so the user can paste the `?code=…&state=…`
 *    URL or bare code (pi-ai's `parseAuthorizationInput` handles
 *    both shapes).
 *
 * ## Cancellation
 *
 * pi-ai's `loginOpenAICodex` does NOT accept an `AbortSignal`, and
 * the local HTTP server's `waitForCode()` never settles on its own —
 * if we just `dialog.clear()` out of `DialogAuthWait`, pi-ai hangs
 * forever with port 1455 bound, and the next retry fails with
 * `EADDRINUSE`. Fix: wire `onManualCodeInput` as a *cancellable*
 * never-resolve promise. When the user ESCs the wait dialog, we
 * reject that promise — pi-ai's `manualPromise.catch` flips
 * `manualError`, calls `server.cancelWait()` which resolves
 * `waitForCode(null)` (pi-ai `:258, :262`), then pi-ai checks
 * `manualError` and rethrows it. The outer `try/finally` reaches
 * `server.close()` and the port is released. The rejection message
 * `"Login cancelled"` is what our catch branch matches to silently
 * swallow the cancel. This is the only clean-unwind path pi-ai
 * exposes at 0.69.0 without an `AbortSignal`.
 *
 * We deliberately do NOT use `onManualCodeInput` for its intended
 * purpose — concurrently surfacing a paste lane alongside the browser
 * URL. The paste prompt would replace the DialogAuthWait and hide the
 * primary URL. `onPrompt`'s post-failure fallback already covers the
 * port-busy case.
 */
export async function startOpenAICodexLogin(
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	onModelSelected: (model: Model<Api>) => void,
): Promise<void> {
	const [progress, setProgress] = createSignal("");

	// Cancellation channel: ESC on DialogAuthWait rejects the
	// `onManualCodeInput` promise, which drives pi-ai through its
	// cancel-wait path and cleanly releases the HTTP port. See the
	// "Cancellation" block in the docstring.
	let rejectCancelProbe: ((reason: Error) => void) | null = null;

	try {
		const creds = await loginOpenAICodex({
			onAuth({ url, instructions }) {
				DialogAuthWait.show(
					dialog,
					{
						title: "Sign in to ChatGPT",
						url,
						instructions,
						progress,
					},
					// onClose: fires when the user ESCs the wait dialog.
					// Reject the manual-code lane; pi-ai picks up the
					// rejection, calls `server.cancelWait()`, and the
					// outer `finally` closes the HTTP server.
					() => {
						rejectCancelProbe?.(new Error("Login cancelled"));
						rejectCancelProbe = null;
					},
				);
			},
			onManualCodeInput: () =>
				// A never-resolving promise that only settles via
				// external rejection from the DialogAuthWait onClose.
				// pi-ai races this against `waitForCode()`; on the
				// success path the browser callback wins and the
				// promise is orphaned (harmless — pi-ai doesn't await
				// it once `waitForCode` has a code). On the cancel
				// path our rejection propagates through pi-ai's
				// `manualError` branch as documented above.
				new Promise<string>((_resolve, reject) => {
					rejectCancelProbe = reject;
				}),
			onPrompt: async ({ message, placeholder, allowEmpty }) => {
				const value = await DialogPrompt.show(dialog, {
					title: "Paste authorization code",
					description: () => <text fg={mutedColor}>{message}</text>,
					placeholder,
					allowEmpty,
				});
				if (value === null) {
					// User ESCd the prompt. Throw so pi-ai's outer
					// try/finally unwinds cleanly (closing the HTTP
					// server and returning control to us).
					throw new Error("Login cancelled");
				}
				return value;
			},
			onProgress(msg) {
				setProgress(msg);
			},
		});

		saveOpenAICodexCreds(creds);
		dialog.clear();
		toast.show({
			variant: "success",
			message: "ChatGPT connected.",
		});
		const codexProvider = getProvider("openai-codex");
		DialogModel.show(
			dialog,
			{
				providerId: "openai-codex",
				modelId: codexProvider.defaultModelId,
			},
			onModelSelected,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === "Login cancelled") {
			dialog.clear();
			return;
		}
		dialog.clear();
		// pi-ai throws "Failed to extract accountId from token" when the
		// OAuth succeeded but the account lacks Codex entitlement (no
		// active ChatGPT Plus / Pro subscription). Raw message is
		// opaque; surface a targeted explanation. Case-insensitive match
		// against both `accountid` and `account_id` in case pi-ai
		// rephrases the throw (the semantic is "we couldn't extract
		// the account from the token").
		const lowered = message.toLowerCase();
		const friendly =
			lowered.includes("accountid") || lowered.includes("account_id")
				? "ChatGPT login succeeded, but this account does not have Codex access. A ChatGPT Plus or Pro subscription is required."
				: `ChatGPT login failed: ${message}`;
		toast.show({
			variant: "error",
			message: friendly,
		});
	}
}
