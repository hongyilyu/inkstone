/**
 * Bottom suggestion panel — replaces `Prompt` while a `suggest_command`
 * tool call is awaiting the user's decision. Mirrors
 * `PermissionPrompt`'s chrome and keybind pattern so both "agent is
 * waiting on you" panels read the same.
 *
 * Three actions, `←/h` `→/l` to cycle and Enter to commit:
 *   - Confirm: resolves the tool with `"confirmed"`. The provider
 *     queues the slash for post-turn replay so the command runs as a
 *     fresh user turn once the current turn's agent_end fires.
 *   - Edit: resolves with `"edited"` and pre-populates the prompt
 *     textarea with `/<command> <args>`. The tool turn still ends;
 *     the user owns what happens next.
 *   - Cancel: resolves with `"cancelled"`. Same as Esc.
 *
 * Tripwire: `useKeyboard` null-guards on `req()` against the one-frame
 * window between `setPendingSuggestion(null)` and `<Show>` unmounting.
 */

import { useKeyboard } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { getInputRef } from "../app";
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
		if (choice === "edit") {
			// Drop the slash into the textarea before resolving the
			// tool. Resolving first triggers the tool's promise to
			// settle and the turn to wind down; the setText happens
			// while the Prompt isn't yet mounted (SuggestCommandPrompt
			// is still in the panel slot until the Show flips). Doing
			// the setText first relies on the existing inputRef
			// surviving the prompt-cell swap, which it does because
			// the Prompt component is unmounted/remounted but
			// `getInputRef()` returns null during the transition — so
			// we schedule the textarea update after the flip via
			// queueMicrotask. Either ordering works; explicit
			// scheduling makes the intent clear.
			const slash = entry.args
				? `/${entry.command} ${entry.args}`
				: `/${entry.command} `;
			respondSuggestion("edited");
			queueMicrotask(() => {
				const input = getInputRef();
				if (input && !input.isDestroyed) {
					input.setText(slash);
					input.cursorOffset = input.plainText.length;
					if (!input.focused) input.focus();
				}
			});
			return;
		}
		respondSuggestion(choice === "confirm" ? "confirmed" : "cancelled");
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
