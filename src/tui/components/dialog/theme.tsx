import { themes, useTheme } from "../../context/theme";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";

interface ThemeOption {
	id: string;
}

export function DialogTheme(props: { currentThemeId: string }) {
	const { setTheme } = useTheme();

	const options: DialogSelectOption<ThemeOption>[] = themes.map((t) => ({
		title: t.name,
		value: { id: t.id },
		description: t.id,
	}));

	return (
		<DialogSelect
			title="Select Theme"
			placeholder="Search themes..."
			options={options}
			current={{ id: props.currentThemeId }}
			onSelect={(option) => {
				setTheme(option.value.id);
			}}
		/>
	);
}

DialogTheme.show = (dialog: DialogContext, currentThemeId: string) => {
	dialog.replace(() => <DialogTheme currentThemeId={currentThemeId} />);
};
