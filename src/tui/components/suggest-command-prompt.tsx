/**
 * Bottom suggestion panel — replaces `Prompt` while a `suggest_command`
 * tool call is awaiting the user's decision. Mirrors
 * `PermissionPrompt`'s chrome and keybind pattern so both "agent is
 * waiting on you" panels read the same.
 *
 * Three actions, `←/h` `→/l` to cycle and Enter to commit:
 *   - Confirm: resolves the tool with `"confirmed"`. The provider
 *     replays the slash through the command registry, which reaches
 *     `actions.prompt` and takes the `agent.followUp` branch so
 *     pi-agent-core drains it at the natural end of the current run.
 *   - Edit: resolves with `"edited"` and pre-populates the prompt
 *     textarea with `/<command> @<arg>`, where the arg is inserted as
 *     a styled mention extmark (same shape the `@`-autocomplete
 *     produces). The mention renders as a chip and the submit path
 *     expands it to an absolute vault path, so the user can't
 *     accidentally mangle the filename while editing.
 *   - Cancel: resolves with `"cancelled"`. Same as Esc.
 *
 * Tripwire: `useKeyboard` null-guards on `req()` against the one-frame
 * window between `setPendingSuggestion(null)` and `<Show>` unmounting.
 */

import { useKeyboard } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { getInputExtmarkIds, getInputRef } from "../app";
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

/**
 * Populate the prompt textarea with `/<command> @<arg>`, inserting the
 * arg as a styled mention extmark so it renders as a chip (same visual
 * contract as an `@`-autocomplete selection). On submit, the existing
 * `expandMentionsToPaths` pipeline rewrites the mention to
 * `resolve(VAULT_DIR, path)`; reader's `/article` accepts absolute
 * paths inside `ARTICLES_DIR`, so the dispatch succeeds exactly as
 * `@`-autocomplete-then-submit does for that command today.
 *
 * Without the extmark the arg would be plain editable text — a user
 * who backspaced a few characters would silently break the filename
 * and reader's `/article` would reject the mangled path.
 *
 * Fallback: when no extmark ids are registered (e.g. prompt hasn't
 * mounted yet — shouldn't happen because the panel can't render
 * without the session view, but guarded), we fall back to plain text.
 */
function populateEditBuffer(command: string, args: string): void {
	const input = getInputRef();
	if (!input || input.isDestroyed) return;

	const verbPrefix = `/${command} `;
	if (args.length === 0) {
		input.setText(verbPrefix);
		input.cursorOffset = input.plainText.length;
		if (!input.focused) input.focus();
		return;
	}

	const { typeId, styleId } = getInputExtmarkIds();
	// `setText` clears extmarks; insert the base text first, then
	// create the extmark over the `@<arg>` span.
	//
	// **Display-width vs code-units.** OpenTUI extmark offsets are
	// display columns (what `offsetExcludingNewlines` derives via
	// `Bun.stringWidth`), not UTF-16 code units. For ASCII-only args
	// the two match and `.length` works; for CJK / full-width
	// characters the code-unit length underestimates and the extmark
	// covers only half the filename. Same fix as
	// `prompt-autocomplete.tsx:insertMention` — matches OpenCode's
	// `autocomplete.tsx:172`.
	const virtualText = `@${args}`;
	input.setText(`${verbPrefix}${virtualText} `);
	input.cursorOffset = input.plainText.length;

	if (typeId !== 0 && styleId !== null) {
		const verbWidth = Bun.stringWidth(verbPrefix);
		input.extmarks.create({
			start: verbWidth,
			end: verbWidth + Bun.stringWidth(virtualText),
			virtual: true,
			styleId,
			typeId,
			metadata: { path: args },
		});
	}

	if (!input.focused) input.focus();
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
			// Resolve the tool first so the Prompt remounts in the cell,
			// then populate the textarea in the next microtask —
			// `getInputRef()` returns null during the panel→prompt
			// transition until the ref callback fires.
			const { command, args } = entry;
			respondSuggestion("edited");
			queueMicrotask(() => populateEditBuffer(command, args));
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
