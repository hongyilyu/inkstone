/**
 * Phase-5 bottom approval panel — replaces the `Prompt` cell while a
 * `confirmDirs` approval is pending. Port of OpenCode's
 * `PermissionPrompt` (`opencode/.../routes/session/permission.tsx`)
 * trimmed to Inkstone's scope:
 *
 *   - Approve / Reject only. "Allow always" is tracked as Future Work
 *     in TODO — it needs a policy-write path into the zone config.
 *
 *   - The diff preview is NOT rendered inside the panel. Phase 4 wires
 *     it into `ToolPart` above, inside the conversation scrollbox, so
 *     the user can scroll it while the panel sits below. OpenCode
 *     renders the diff inside the panel itself; Inkstone doesn't need
 *     to because the conversation already has the diff.
 *
 *   - No ctrl+f fullscreen toggle. OpenCode uses it for large edit
 *     diffs; ours are inline above and always scrollable via the
 *     conversation's own scrollbox.
 *
 * Keybinds are panel-local (not registered in the shared keybind map).
 * This mirrors `DialogConfirm` which handles its own `y`/`n`/←→/enter
 * locally. Conversation scroll keys (`messages_page_up` etc.) stay
 * live — the panel doesn't suspend the global dispatcher, so users
 * can scroll the diff above without losing their place in the panel.
 *
 * Visual chrome is the same three-piece stack as `Prompt`
 * (`src/tui/components/prompt.tsx`): outer `┃` bar + padded inner box
 * with `theme.backgroundElement` fill, then a `╹`-cornered cap row
 * with a `▀` fill, then the hints row. Color is `theme.warning` to
 * signal "this needs attention" — matches the `△` affordance. The
 * shared bubble chrome makes the panel read as "the same cell as
 * Prompt, but warning-tinted" instead of floating disconnected.
 */

import { useKeyboard } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { EmptyBorder } from "./message";

type PanelChoice = "approve" | "reject";

export function PermissionPrompt() {
	const { theme } = useTheme();
	const { pendingApproval, respondApproval } = useAgent();
	const [store, setStore] = createStore({
		active: "approve" as PanelChoice,
	});

	const req = () => pendingApproval();

	useKeyboard((evt: { name: string; defaultPrevented?: boolean }) => {
		if (evt.defaultPrevented) return;
		// Panel is mounted only while `pendingApproval()` is non-null;
		// if something races unmounting (Solid batching corner), bail
		// out gracefully rather than calling the resolver on null.
		if (!req()) return;

		if (evt.name === "return") {
			respondApproval(store.active === "approve");
			return;
		}
		if (evt.name === "escape") {
			respondApproval(false);
			return;
		}
		if (
			evt.name === "left" ||
			evt.name === "h" ||
			evt.name === "right" ||
			evt.name === "l"
		) {
			// Two-option toggle — both directions flip the selection.
			setStore("active", store.active === "approve" ? "reject" : "approve");
		}
	});

	return (
		<box flexShrink={0}>
			{/* Body: left `┃` bar in warning, padded inner box in
			    backgroundElement — same shape as Prompt's input
			    bubble. flexGrow={1} on both so the bar extends the
			    full cell width. */}
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
						<text fg={theme.warning}>△ Permission required</text>
						<text fg={theme.text}>{req()?.title ?? ""}</text>
						<text fg={theme.textMuted}>{req()?.message ?? ""}</text>
					</box>

					<box flexDirection="row" gap={2}>
						{(["approve", "reject"] as const).map((key) => (
							<box
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={
									key === store.active ? theme.warning : undefined
								}
								onMouseUp={() => respondApproval(key === "approve")}
							>
								<text
									fg={
										key === store.active
											? theme.selectedListItemText
											: theme.textMuted
									}
								>
									{key === "approve" ? "Allow" : "Reject"}
								</text>
							</box>
						))}
					</box>
				</box>
			</box>

			{/* Cap row: ╹ corner on the left, ▀ fill across. Matches
			    Prompt's cap (see src/tui/components/prompt.tsx around
			    the "prompt/index.tsx:1226" comment). */}
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

			{/* Hints row, aligned with Prompt's hints row. */}
			<box paddingLeft={3} flexDirection="row" gap={2}>
				<text fg={theme.textMuted}>← → select</text>
				<text fg={theme.textMuted}>enter confirm</text>
				<text fg={theme.textMuted}>esc reject</text>
			</box>
		</box>
	);
}
