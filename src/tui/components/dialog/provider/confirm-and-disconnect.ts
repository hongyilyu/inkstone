import {
	findFirstConnectedProvider,
	type ProviderInfo,
	resolveModel,
} from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { DialogContext } from "../../../ui/dialog";
import { DialogConfirm } from "../../../ui/dialog-confirm";
import type { ToastContext } from "../../../ui/toast";

/**
 * Shared confirm-then-disconnect helper.
 *
 * Replaces the three parallel `confirmAndDisconnect{Kiro,OpenAICodex,
 * OpenRouter}` files that carried ~75 lines each of near-identical
 * confirm → clear → rehome → toast logic. The per-provider credential
 * wipe lives on `ProviderInfo.clearCreds()`; the UI flow (DialogConfirm,
 * rehome via `findFirstConnectedProvider`, toast variants) is generic.
 *
 * Flow:
 *   1. DialogConfirm.show with `Disconnect ${displayName}?`.
 *   2. On confirm, call `provider.clearCreds()`.
 *   3. If the disconnected provider was the session's active provider,
 *      rehome via `findFirstConnectedProvider(provider.id)`. First
 *      connected fallback wins; `undefined` → warning toast nudging
 *      /models; success → switch toast.
 *   4. Wrap the whole sequence in try/catch — `clearCreds()` should
 *      route storage errors through `reportPersistenceError`
 *      internally (see auth.ts atomic-write path), but an unexpected
 *      synchronous throw surfaces as an error toast here rather than
 *      an unhandled promise rejection.
 *
 * Intentional copy change from the old per-provider files: OpenRouter's
 * confirm body previously read `"Stored API key will be removed…"`
 * while Kiro / Codex used `"Stored credentials will be removed…"`.
 * The unified message uses "credentials" as the umbrella term covering
 * both OAuth tokens and API keys. Accepted drift — no test asserts the
 * exact body, and the unification matches the generic helper's role.
 */
export async function confirmAndDisconnect(
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
	// `DialogConfirm.show` resolves `true` on confirm, `false` on
	// cancel, `undefined` on ESC. Only proceed on explicit confirm.
	if (confirmed !== true) return;

	try {
		provider.clearCreds();

		let rehomed = false;
		if (activeProviderId === provider.id) {
			const fallback = findFirstConnectedProvider(provider.id);
			if (fallback) {
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
	} catch (err) {
		console.error("[inkstone] disconnect failed:", err);
		toast.show({
			variant: "error",
			message: `${provider.displayName} disconnect failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
}
