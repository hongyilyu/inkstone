import { type Api, getModels, type Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";

type AnyModel = Model<Api>;

interface ModelValue {
	id: string;
	provider: string;
}

export function DialogModel(props: {
	currentModelId: string;
	onSelect: (model: AnyModel) => void;
}) {
	const options = createMemo<DialogSelectOption<ModelValue>[]>(() => {
		const models = getModels("amazon-bedrock");
		return models.map((m) => ({
			title: m.name,
			value: { id: m.id, provider: m.provider },
			description: m.provider,
		}));
	});

	return (
		<DialogSelect
			title="Select Model"
			placeholder="Search models..."
			options={options()}
			current={{ id: props.currentModelId, provider: "amazon-bedrock" }}
			onSelect={(option) => {
				const models = getModels("amazon-bedrock");
				const model = models.find((m) => m.id === option.value.id);
				if (model) props.onSelect(model);
			}}
		/>
	);
}

DialogModel.show = (
	dialog: DialogContext,
	currentModelId: string,
	onSelect: (model: AnyModel) => void,
) => {
	dialog.replace(() => (
		<DialogModel currentModelId={currentModelId} onSelect={onSelect} />
	));
};
