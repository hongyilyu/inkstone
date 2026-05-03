import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";
import { useDialog } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";
import * as Keybind from "../../util/keybind";
import type { CommandOption } from "./command";

/**
 * Internal palette component. Not exported from the main `command`
 * barrel — opened exclusively by `CommandProvider` in response to the
 * `command_list` keybind. Consumers that want to open it programmatically
 * use `useCommand().show()` which calls `dialog.replace(<DialogCommand ... />)`.
 *
 * Pure UI: maps `CommandOption[]` → `DialogSelectOption<string>[]` and
 * wires `onSelect` back through the command registry's entry lookup.
 * No registry state lives here.
 */
export function DialogCommand(props: { visible: Accessor<CommandOption[]> }) {
	const dialog = useDialog();

	const options = createMemo<DialogSelectOption<string>[]>(() =>
		props.visible().map((entry) => ({
			title: entry.title,
			value: entry.id,
			description: formatDescription(entry),
		})),
	);

	return (
		<DialogSelect
			title="Command Panel"
			placeholder="Search commands..."
			options={options()}
			closeOnSelect={false}
			onSelect={(option) => {
				const entry = props.visible().find((e) => e.id === option.value);
				if (!entry) return;
				entry.onSelect(dialog);
			}}
		/>
	);
}

/**
 * Combine description and keybind hint for display in the palette:
 *   - both:          `"Switch agent (tab)"`
 *   - keybind only:  `"tab"`
 *   - description:   `"Switch agent"`
 *   - neither:       `undefined`
 */
function formatDescription(entry: CommandOption): string | undefined {
	const hint = entry.keybind ? Keybind.print(entry.keybind) : "";
	if (entry.description && hint) return `${entry.description} (${hint})`;
	if (entry.description) return entry.description;
	if (hint) return hint;
	return undefined;
}
