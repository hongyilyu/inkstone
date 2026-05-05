/**
 * Bottom approval panel — replaces `Prompt` while a `confirmDirs`
 * approval is pending. See `docs/APPROVAL-UI.md` § Rendering for the
 * chrome rationale, keybind table, and OpenCode divergences.
 *
 * Tripwire: `useKeyboard` null-guards on `req()` against the one-frame
 * window between `setPendingApproval(null)` and `<Show>` unmounting.
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
			setStore("active", store.active === "approve" ? "reject" : "approve");
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
