import { useKeyboard } from "@opentui/solid";
import fuzzysort from "fuzzysort";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	Show,
} from "solid-js";
import { useTheme } from "../context/theme";
import { useDialog } from "../ui/dialog";
import { type CommandOption, useCommand } from "./dialog-command";

/** A visible command entry with the `slash` field narrowed to non-null. */
type SlashEntry = CommandOption & { slash: { name: string } };

/** Handle consumed by `<Prompt>` to feed input + resolve Enter. */
export interface AutocompleteRef {
	visible: Accessor<boolean>;
	onInput(text: string): void;
	select(): void;
	hide(): void;
}

interface AutocompleteProps {
	ref: (r: AutocompleteRef) => void;
	clearText: () => void;
}

/**
 * Inline slash-command dropdown. Opens when the textarea value matches
 * `/^\/[^\s]*$/` and dismisses the moment that invariant breaks. Rendered
 * `position="absolute"` inside the prompt outer box so it floats above
 * the input without affecting layout; sibling-in-parent positioning
 * inherits layout reactively — no anchor polling.
 *
 * Keybind suppression while visible: toggles
 * `useCommand().setSuppressed(visible())` so `CommandProvider` (which
 * fires earlier in registration order than this handler) short-circuits
 * its dispatch; `preventDefault` alone would arrive too late.
 */
export function Autocomplete(props: AutocompleteProps) {
	const { theme } = useTheme();
	const command = useCommand();
	const dialog = useDialog();

	const [visible, setVisible] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);

	const entries = createMemo<SlashEntry[]>(() =>
		command
			.visible()
			.filter((e): e is SlashEntry => !!e.slash)
			.slice()
			.sort((a, b) => a.slash.name.localeCompare(b.slash.name)),
	);

	// Fuzzysort over slash name + description. No prefix boost, no limit —
	// the palette is small enough that defaults rank correctly.
	const filtered = createMemo<SlashEntry[]>(() => {
		const q = query();
		const list = entries();
		if (!q) return list;
		const results = fuzzysort.go(q, list, {
			keys: [(e) => e.slash.name, (e) => e.description ?? ""],
		});
		return results.map((r) => r.obj);
	});

	// Clamp selected when filtering shrinks the list.
	createEffect(() => {
		const len = filtered().length;
		if (selected() >= len) setSelected(Math.max(0, len - 1));
	});

	// Suspend global keybind dispatch while visible.
	createEffect(() => {
		command.setSuppressed(visible());
	});

	function hide() {
		setVisible(false);
		setQuery("");
		setSelected(0);
	}

	function onInput(text: string) {
		const match = text.match(/^\/([^\s]*)$/);
		if (!match) {
			if (visible()) hide();
			return;
		}
		if (!visible()) setSelected(0);
		setQuery(match[1] ?? "");
		setVisible(true);
	}

	function select() {
		const chosen = filtered()[selected()];
		if (!chosen) return;
		hide();
		props.clearText();
		chosen.onSelect(dialog);
	}

	props.ref({ visible, onInput, select, hide });

	useKeyboard((evt: any) => {
		if (!visible()) return;

		if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
			evt.preventDefault?.();
			setSelected((s) => Math.max(0, s - 1));
			return;
		}
		if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
			evt.preventDefault?.();
			setSelected((s) => Math.min(filtered().length - 1, s + 1));
			return;
		}
		if (evt.name === "escape") {
			evt.preventDefault?.();
			hide();
			props.clearText();
			return;
		}
		// Tab and Enter both confirm. Enter is also covered by `handleSubmit`
		// short-circuit in prompt.tsx — belt-and-suspenders.
		if (evt.name === "tab" || evt.name === "return" || evt.name === "enter") {
			evt.preventDefault?.();
			select();
			return;
		}
	});

	return (
		<Show when={visible() && filtered().length > 0}>
			<box
				position="absolute"
				bottom={6}
				left={0}
				right={0}
				flexDirection="column"
				backgroundColor={theme.backgroundPanel}
				borderStyle="single"
				borderColor={theme.border}
				zIndex={100}
			>
				<For each={filtered()}>
					{(item, i) => (
						<box
							flexDirection="row"
							backgroundColor={i() === selected() ? theme.primary : undefined}
							paddingLeft={1}
							paddingRight={1}
						>
							<text fg={i() === selected() ? theme.background : theme.text}>
								/{item.slash.name}
							</text>
							<Show when={item.description}>
								<text
									marginLeft={2}
									fg={i() === selected() ? theme.background : theme.textMuted}
								>
									{item.description}
								</text>
							</Show>
						</box>
					)}
				</For>
			</box>
		</Show>
	);
}
