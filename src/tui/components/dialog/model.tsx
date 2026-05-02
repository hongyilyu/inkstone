import { getProvider, listProviders } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";

type AnyModel = Model<Api>;

interface ModelValue {
	providerId: string;
	modelId: string;
}

/**
 * Flat model picker.
 *
 * Lists models from every *connected* provider. Disconnected providers are
 * hidden — use the Connect dialog to set credentials and make them appear.
 * Options carry `category: provider.displayName`; DialogSelect renders that
 * as a group header over the per-provider run, so the description column
 * is left empty (the provider name would otherwise duplicate the header
 * on every row).
 */
export function DialogModel(props: {
	current: ModelValue;
	onSelect: (model: AnyModel) => void;
}) {
	const connectedProviders = createMemo(() =>
		listProviders().filter((p) => p.isConnected()),
	);

	const options = createMemo<DialogSelectOption<ModelValue>[]>(() =>
		connectedProviders().flatMap((provider) =>
			provider.listModels().map((m) => ({
				title: m.name,
				value: { providerId: provider.id, modelId: m.id },
				category: provider.displayName,
			})),
		),
	);

	return (
		<DialogSelect
			title="Select Model"
			placeholder={
				connectedProviders().length === 0
					? "No providers connected — use Connect to set credentials"
					: "Search models..."
			}
			options={options()}
			current={props.current}
			onSelect={(option) => {
				const provider = getProvider(option.value.providerId);
				if (!provider) return;
				const models = provider.listModels();
				const model = models.find((m) => m.id === option.value.modelId);
				if (model) props.onSelect(model);
			}}
		/>
	);
}

DialogModel.show = (
	dialog: DialogContext,
	current: ModelValue,
	onSelect: (model: AnyModel) => void,
) => {
	dialog.replace(() => <DialogModel current={current} onSelect={onSelect} />);
};
