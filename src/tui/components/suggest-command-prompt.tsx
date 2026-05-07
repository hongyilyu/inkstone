/**
 * Bottom suggestion panel — replaces `Prompt` while a `suggest_command`
 * tool call awaits the user's decision. See `docs/AGENT-DESIGN.md`
 * D15 for the confirm/edit/cancel contract and replay flow.
 *
 * Keybinds: `←/h` `→/l` cycle Confirm / Edit / Cancel, Enter commits,
 * Esc cancels. Mirrors `PermissionPrompt`'s chrome.
 *
 * Tripwire: `useKeyboard` null-guards on `req()` against the one-frame
 * window between `setPendingSuggestion(null)` and `<Show>` unmounting.
 */

import { useKeyboard } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { EmptyBorder } from "./message";

type PanelChoice = "confirm" | "edit" | "cancel";
const CHOICES: readonly PanelChoice[] = ["confirm", "edit", "cancel"];

function cycle(active: PanelChoice, dir: 1 | -1): PanelChoice {
	const idx = CHOICES.indexOf(active);
	const next = (idx + dir + CHOICES.length) % CHOICES.length;
	// biome-ignore lint/style/noNonNullAssertion: modular index, always in-bounds
	return CHOICES[next]!;
}

function label(choice: PanelChoice): string {
	if (choice === "confirm") return "Confirm";
	if (choice === "edit") return "Edit";
	return "Cancel";
}

export function SuggestCommandPrompt() {
	const { theme } = useTheme();
	const { pendingSuggestion, respondSuggestion } = useAgent();
	const [store, setStore] = createStore({
		active: "confirm" as PanelChoice,
	});

	const req = () => pendingSuggestion();

	function commit(choice: PanelChoice): void {
		const entry = req();
		if (!entry) return;
		const decision =
			choice === "confirm"
				? "confirmed"
				: choice === "edit"
					? "edited"
					: "cancelled";
		respondSuggestion(decision);
	}

	useKeyboard((evt: { name: string; defaultPrevented?: boolean }) => {
		if (evt.defaultPrevented) return;
		if (!req()) return;

		if (evt.name === "return") {
			commit(store.active);
			return;
		}
		if (evt.name === "escape") {
			commit("cancel");
			return;
		}
		if (evt.name === "left" || evt.name === "h") {
			setStore("active", cycle(store.active, -1));
			return;
		}
		if (evt.name === "right" || evt.name === "l") {
			setStore("active", cycle(store.active, 1));
		}
	});

	return (
		<box flexShrink={0}>
			<box
				flexShrink={0}
				flexGrow={1}
				border={["left"]}
				borderColor={theme.info}
				customBorderChars={{
					...EmptyBorder,
					vertical: "┃",
				}}
			>
				<box
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
					flexShrink={0}
					flexGrow={1}
					backgroundColor={theme.backgroundElement}
					flexDirection="column"
					gap={1}
				>
					<box flexDirection="column">
						<text fg={theme.info}>▸ Suggested command</text>
						<text fg={theme.text}>
							/{req()?.command ?? ""}
							{req()?.args ? ` ${req()?.args}` : ""}
						</text>
						<text fg={theme.textMuted}>{req()?.rationale ?? ""}</text>
					</box>

					<box flexDirection="row" gap={2}>
						{CHOICES.map((key) => (
							<box
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={key === store.active ? theme.info : undefined}
								onMouseUp={() => commit(key)}
							>
								<text
									fg={
										key === store.active
											? theme.selectedListItemText
											: theme.textMuted
									}
								>
									{label(key)}
								</text>
							</box>
						))}
					</box>
				</box>
			</box>

			<box
				height={1}
				border={["left"]}
				borderColor={theme.info}
				customBorderChars={{
					...EmptyBorder,
					vertical: "╹",
				}}
			>
				<box
					height={1}
					border={["bottom"]}
					borderColor={theme.backgroundElement}
					customBorderChars={{
						...EmptyBorder,
						horizontal: "▀",
					}}
				/>
			</box>

			<box paddingLeft={3} flexDirection="row" gap={2}>
				<text fg={theme.textMuted}>← → select</text>
				<text fg={theme.textMuted}>enter commit</text>
				<text fg={theme.textMuted}>esc cancel</text>
			</box>
		</box>
	);
}
