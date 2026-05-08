/**
 * Bottom approval panel — replaces `Prompt` while a confirmation is
 * pending. See `docs/APPROVAL-UI.md` § Rendering for the chrome
 * rationale, keybind table, and OpenCode divergences.
 *
 * Presentational: callers pass the request text, the labels, the
 * pending accessor (for the keyboard null-guard), and the responder.
 * Two callsites today — agent-tool approvals and provider-disconnect
 * confirmations — share this panel via per-action scoped signals.
 *
 * The selection state (`store.active`) IS the boolean that
 * `onRespond` receives — there's no internal "approve"/"reject"
 * identifier mapped to a value. Keep it that way: the choices array
 * pairs each label with its boolean directly.
 *
 * Tripwire: `useKeyboard` null-guards on `pending()` against the
 * one-frame window between the caller clearing its signal and
 * `<Show>` unmounting the subtree.
 */

import { useKeyboard } from "@opentui/solid";
import type { Accessor } from "solid-js";
import { For } from "solid-js";
import { createStore } from "solid-js/store";
import { useTheme } from "../context/theme";
import { EmptyBorder } from "./message";

export interface PermissionPromptProps {
	header: string;
	title: string;
	message: string;
	approveLabel: string;
	rejectLabel: string;
	onRespond: (ok: boolean) => void;
	pending: Accessor<unknown>;
}

export function PermissionPrompt(props: PermissionPromptProps) {
	const { theme } = useTheme();
	const [store, setStore] = createStore({ active: true });

	const choices = (): readonly { label: string; value: boolean }[] => [
		{ label: props.approveLabel, value: true },
		{ label: props.rejectLabel, value: false },
	];

	useKeyboard((evt: { name: string; defaultPrevented?: boolean }) => {
		if (evt.defaultPrevented) return;
		if (!props.pending()) return;

		if (evt.name === "return") {
			props.onRespond(store.active);
			return;
		}
		if (evt.name === "escape") {
			props.onRespond(false);
			return;
		}
		if (
			evt.name === "left" ||
			evt.name === "h" ||
			evt.name === "right" ||
			evt.name === "l"
		) {
			setStore("active", !store.active);
		}
	});

	return (
		<box flexShrink={0}>
			{/* Body: ┃ bar + padded inner in backgroundElement. */}
			<box
				flexShrink={0}
				flexGrow={1}
				border={["left"]}
				borderColor={theme.warning}
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
						<text fg={theme.warning}>{props.header}</text>
						<text fg={theme.text}>{props.title}</text>
						<text fg={theme.textMuted}>{props.message}</text>
					</box>

					<box flexDirection="row" gap={2}>
						<For each={choices()}>
							{(choice) => (
								<box
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										choice.value === store.active ? theme.warning : undefined
									}
									onMouseUp={() => props.onRespond(choice.value)}
								>
									<text
										fg={
											choice.value === store.active
												? theme.selectedListItemText
												: theme.textMuted
										}
									>
										{choice.label}
									</text>
								</box>
							)}
						</For>
					</box>
				</box>
			</box>

			{/* Cap row: ╹ corner + ▀ fill. */}
			<box
				height={1}
				border={["left"]}
				borderColor={theme.warning}
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
				<text fg={theme.textMuted}>enter confirm</text>
				<text fg={theme.textMuted}>esc reject</text>
			</box>
		</box>
	);
}
