import { logger } from "@backend/logger";
import {
	findFirstConnectedProvider,
	type ProviderInfo,
	resolveModel,
} from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { DialogContext } from "../../../ui/dialog";
import type { ToastContext } from "../../../ui/toast";
import { requestDisconnectConfirmation } from "../../disconnect-confirmation";

const log = logger.child("tui.disconnect");

/**
 * Shared confirm-then-disconnect helper.
 *
 * Replaces the three parallel `confirmAndDisconnect{Kiro,OpenAICodex,
 * OpenRouter}` files that carried ~75 lines each of near-identical
 * confirm → clear → rehome → toast logic. The per-provider credential
 * wipe lives on `ProviderInfo.clearCreds()`; the UI flow (panel
 * confirmation, rehome via `findFirstConnectedProvider`, toast
 * variants) is generic.
 *
 * Flow:
 *   1. Close the manage-providers dialog (via `dialog.clear()`) so the
 *      bottom `PermissionPrompt` panel owns keyboard input
 *      unambiguously, then await `requestDisconnectConfirmation`. The
 *      panel resolves `true` on Enter, `false` on Esc — there is no
 *      `undefined` case (matches the agent-tool approval flow).
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
	dialog.clear();
	const confirmed = await requestDisconnectConfirmation({
		title: `Disconnect ${provider.displayName}?`,
		message:
			"Stored credentials will be removed from this device. You can reconnect anytime from this dialog.",
	});
	if (!confirmed) return;

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
		log.warn(
			"disconnect failed",
			err instanceof Error ? err : new Error(String(err)),
		);
		toast.show({
			variant: "error",
			message: `${provider.displayName} disconnect failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
}
