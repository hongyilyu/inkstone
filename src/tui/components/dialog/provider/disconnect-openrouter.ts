import { clearOpenRouterKey } from "@backend/persistence/auth";
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
 * Confirm-then-disconnect for OpenRouter.
 *
 * Mirrors `./disconnect-kiro.ts` and `./disconnect-openai-codex.ts` —
 * same rehome chain: if the active session is pointing at OpenRouter,
 * swap to the first other connected provider's default model,
 * otherwise emit a warning toast nudging `/models`.
 *
 * PR #2 collapses the three `confirmAndDisconnect*` files + their
 * dispatchers into a single shared helper via
 * `ProviderInfo.clearCreds()` + a provider-keyed lookup.
 */
export async function confirmAndDisconnectOpenRouter(
	dialog: DialogContext,
	toast: ToastContext,
	provider: ProviderInfo,
	onModelSelected: (model: Model<Api>) => void,
	activeProviderId: string | undefined,
): Promise<void> {
	const confirmed = await DialogConfirm.show(
		dialog,
		`Disconnect ${provider.displayName}?`,
		"Stored API key will be removed from this device. You can reconnect anytime from this dialog.",
	);
	if (confirmed !== true) return;

	try {
		clearOpenRouterKey();

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
