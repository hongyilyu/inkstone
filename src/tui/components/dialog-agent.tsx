import { listAgents } from "@backend/agent";
import { useAgent } from "../context/agent";
import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";

interface AgentOption {
	name: string;
}

/**
 * Agent selection dialog. Mirrors OpenCode's component/dialog-agent.tsx —
 * a plain `DialogSelect` over the static agent registry.
 *
 * Inkstone only shows this dialog from the command palette when the session
 * is empty (see dialog-command.tsx), so we don't need to guard the select
 * callback against mid-session switches.
 */
export function DialogAgent() {
	const { store, actions } = useAgent();

	const options: DialogSelectOption<AgentOption>[] = listAgents().map((a) => ({
		title: a.displayName,
		value: { name: a.name },
		description: a.description,
	}));

	return (
		<DialogSelect
			title="Select agent"
			placeholder="Search agents..."
			options={options}
			current={{ name: store.currentAgent }}
			onSelect={(option) => {
				actions.selectAgent(option.value.name);
			}}
		/>
	);
}

DialogAgent.show = (dialog: DialogContext) => {
	dialog.replace(() => <DialogAgent />);
};
