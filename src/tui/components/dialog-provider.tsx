import { listProviders } from "@backend/providers";
import { createMemo } from "solid-js";
import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import { useToast } from "../ui/toast";

interface ProviderValue {
	id: string;
}

/**
 * Provider connection-management dialog.
 *
 * Lists every registered provider with a connection status. Selecting a
 * *connected* provider is a no-op (closes the dialog) — manage/disconnect
 * actions land when a second provider exists and the flow can be exercised.
 * Selecting a *disconnected* provider shows a toast with its auth
 * instructions so the user knows which env vars to set.
 *
 * The companion Models dialog lists only models from connected providers,
 * so this dialog is the gateway for making new providers usable.
 */
export function DialogProvider() {
	const toast = useToast();

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
			onSelect={(option) => {
				const provider = listProviders().find((p) => p.id === option.value.id);
				if (!provider) return;
				if (provider.isConnected()) {
					// No management actions yet — just close (default DialogSelect
					// behavior). Reserved for future disconnect / re-auth flows.
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

DialogProvider.show = (dialog: DialogContext) => {
	dialog.replace(() => <DialogProvider />);
};
