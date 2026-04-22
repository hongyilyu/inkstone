import type { AgentActions } from "@backend/agent";
import { getCurrentModelId } from "@backend/agent";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import { DialogAgent } from "./dialog-agent";
import { DialogModel } from "./dialog-model";
import { DialogProvider as DialogProviderSelect } from "./dialog-provider";
import { DialogTheme } from "./dialog-theme";

interface CommandOption {
	id: string;
}

export function DialogCommand(props: {
	dialog: DialogContext;
	actions: AgentActions;
}) {
	const { themeId } = useTheme();
	const { store } = useAgent();

	// Agent switching is only meaningful on an empty session; hide the option
	// once messages exist so the palette doesn't advertise a no-op. The store
	// can't change while this dialog is open (input is blurred), so a
	// single-shot computation is sufficient.
	const canSwitchAgent = store.messages.length === 0;

	const options: DialogSelectOption<CommandOption>[] = [
		...(canSwitchAgent
			? [
					{
						title: "Agents",
						value: { id: "agents" },
						description: "Switch agent",
					},
				]
			: []),
		{ title: "Models", value: { id: "models" }, description: "Switch model" },
		{ title: "Themes", value: { id: "themes" }, description: "Switch theme" },
		{
			title: "Connect",
			value: { id: "connect" },
			description: "Switch provider",
		},
	];

	return (
		<DialogSelect
			title="Command Panel"
			placeholder="Search commands..."
			options={options}
			closeOnSelect={false}
			onSelect={(option) => {
				switch (option.value.id) {
					case "agents":
						DialogAgent.show(props.dialog);
						break;
					case "models":
						DialogModel.show(props.dialog, getCurrentModelId(), (model) => {
							props.actions.setModel(model);
							props.dialog.clear();
						});
						break;
					case "themes":
						DialogTheme.show(props.dialog, themeId());
						break;
					case "connect":
						DialogProviderSelect.show(props.dialog);
						break;
				}
			}}
		/>
	);
}

DialogCommand.show = (dialog: DialogContext, actions: AgentActions) => {
	dialog.replace(() => <DialogCommand dialog={dialog} actions={actions} />);
};
