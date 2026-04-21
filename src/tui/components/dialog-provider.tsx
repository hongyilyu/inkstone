import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import { useToast } from "../ui/toast";

interface ProviderOption {
	id: string;
	supported: boolean;
}

export function DialogProvider() {
	const toast = useToast();

	const options: DialogSelectOption<ProviderOption>[] = [
		{
			title: "Amazon Bedrock",
			value: { id: "amazon-bedrock", supported: true },
			description: "Active",
		},
		{
			title: "Anthropic",
			value: { id: "anthropic", supported: false },
			description: "Not yet supported",
		},
		{
			title: "OpenAI",
			value: { id: "openai", supported: false },
			description: "Not yet supported",
		},
	];

	return (
		<DialogSelect
			title="Select Provider"
			placeholder="Search providers..."
			options={options}
			current={{ id: "amazon-bedrock", supported: true }}
			onSelect={(option) => {
				if (!option.value.supported) {
					toast.show({
						variant: "warning",
						message: `${option.title} is not yet supported`,
					});
				}
			}}
		/>
	);
}

DialogProvider.show = (dialog: DialogContext) => {
	dialog.replace(() => <DialogProvider />);
};
