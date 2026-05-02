import { saveOpenRouterKey } from "@backend/persistence/auth";
import { getProvider } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import { DialogPrompt } from "../../../ui/dialog-prompt";
import type { ToastContext } from "../../../ui/toast";
import { DialogModel } from "../model";

/**
 * OpenRouter key-entry flow.
 *
 * Single-step: the user pastes their OpenRouter API key into a
 * `DialogPrompt`. Success → `saveOpenRouterKey` → toast → `DialogModel`
 * scoped to OpenRouter so the user immediately lands on the catalog.
 *
 * Deliberately simpler than Codex's PKCE flow or Kiro's device-code
 * flow — there's no browser callback server, no token refresh, no
 * in-flight dedup. The key lives on disk in `~/.config/inkstone/auth.json`
 * at mode 0600 and is read verbatim on every turn.
 *
 * Cancellation: ESC on the prompt resolves `DialogPrompt.show` to
 * `null`. The flow returns without mutating state. No partial-save
 * path — the key is either fully stored or not stored at all.
 */
export async function setOpenRouterKey(
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	_primaryColor: ReturnType<typeof useTheme>["theme"]["primary"],
	onModelSelected: (model: Model<Api>) => void,
): Promise<void> {
	const value = await DialogPrompt.show(dialog, {
		title: "OpenRouter API key",
		description: () => (
			<box>
				<text fg={mutedColor} wrapMode="word">
					Paste your OpenRouter API key. Create one at
					https://openrouter.ai/keys
				</text>
			</box>
		),
		placeholder: "sk-or-v1-...",
	});

	if (value === null) {
		dialog.clear();
		return;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		dialog.clear();
		toast.show({
			variant: "warning",
			message: "OpenRouter key was empty. Connect again to retry.",
		});
		return;
	}

	// Resolve the provider BEFORE announcing success. Matches the
	// ordering in sibling login flows so a hypothetical registry
	// drift where "openrouter" disappears fails loudly here instead
	// of greeting the user with a success toast and then dropping
	// them back with no picker.
	const openrouterProvider = getProvider("openrouter");
	if (!openrouterProvider) {
		dialog.clear();
		toast.show({
			variant: "error",
			message: "OpenRouter provider is unavailable.",
		});
		return;
	}

	saveOpenRouterKey(trimmed);
	dialog.clear();
	toast.show({
		variant: "success",
		message: "OpenRouter connected.",
	});
	DialogModel.show(
		dialog,
		{
			providerId: "openrouter",
			modelId: openrouterProvider.defaultModelId,
		},
		onModelSelected,
	);
}
