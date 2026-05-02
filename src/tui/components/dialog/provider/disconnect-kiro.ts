import { clearKiroCreds } from "@backend/persistence/auth";
import {
	DEFAULT_PROVIDER,
	getProvider,
	type ProviderInfo,
	resolveModel,
} from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { DialogContext } from "../../../ui/dialog";
import { DialogConfirm } from "../../../ui/dialog-confirm";
import type { ToastContext } from "../../../ui/toast";

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
export async function confirmAndDisconnectKiro(
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

	// Wrap the whole disconnect+rehome sequence. `clearKiroCreds` and
	// `saveConfig` (driven by `setModel`) route I/O errors through
	// `reportPersistenceError` internally, so they shouldn't throw; this
	// is defense-in-depth for the fire-and-forget call site so an
	// unexpected synchronous failure surfaces as a toast instead of an
	// unhandled promise rejection.
	try {
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
