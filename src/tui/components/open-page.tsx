import { VAULT_DIR } from "@backend/agent/constants";
import { Show } from "solid-js";
import pkg from "../../../package.json";
import { useTheme } from "../context/theme";
import { displayPath } from "../util/format";
import {
	pendingDisconnect,
	respondDisconnect,
} from "./disconnect-confirmation";
import { PermissionPrompt } from "./permission-prompt";
import { Prompt } from "./prompt";

/**
 * Open page shown when no messages exist.
 * Centered layout with logo, prompt, and footer.
 * Matches OpenCode's routes/home.tsx:55-89 structure.
 *
 * NOTE: Agent approvals (`pendingApproval`) and command suggestions
 * (`pendingSuggestion`) can never fire here — they require a
 * user-turn `prompt()` which pushes a user message before the backend
 * runs, so `Layout` has already swapped to the conversation branch by
 * then. Disconnect (`pendingDisconnect`) is the exception: it fires
 * from `Ctrl+P` → Connect → Manage → Disconnect, which is reachable
 * from `OpenPage` (no messages yet). That branch swaps the centered
 * `Prompt` for `PermissionPrompt` so the user can confirm in place.
 */
export function OpenPage() {
	const { theme } = useTheme();

	// Display vault path with ~ for home dir (platform-neutral helper).
	const vaultDisplay = displayPath(VAULT_DIR);

	return (
		<box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
			{/* Main centered content */}
			{/* Matches OpenCode home.tsx: flexGrow spacers + alignItems center */}
			<box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
				<box flexGrow={1} minHeight={0} />
				<box height={4} minHeight={0} flexShrink={1} />

				{/* Logo: "ink" (muted) + "stone" (primary) */}
				<box flexShrink={0} flexDirection="row">
					<ascii_font text="ink" font="block" color={theme.textMuted} />
					<ascii_font text="stone" font="block" color={theme.primary} />
				</box>

				<box height={1} minHeight={0} flexShrink={1} />

				{/* Prompt input area — max width 75, matches OpenCode home.tsx:66 */}
				<box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
					<Show when={pendingDisconnect()} fallback={<Prompt />}>
						<PermissionPrompt
							header="△ Confirm disconnect"
							title={pendingDisconnect()?.title ?? ""}
							message={pendingDisconnect()?.message ?? ""}
							approveLabel="Disconnect"
							rejectLabel="Cancel"
							onRespond={respondDisconnect}
							pending={pendingDisconnect}
						/>
					</Show>
				</box>

				<box flexGrow={1} minHeight={0} />
			</box>

			{/* Footer: vault dir (left) + version (right) */}
			{/* Matches OpenCode feature-plugins/home/footer.tsx:57-74 */}
			<box
				width="100%"
				paddingTop={1}
				paddingBottom={1}
				paddingLeft={2}
				paddingRight={2}
				flexDirection="row"
				flexShrink={0}
			>
				<text fg={theme.textMuted}>{vaultDisplay}</text>
				<box flexGrow={1} />
				<box flexShrink={0}>
					<text fg={theme.textMuted}>{pkg.version}</text>
				</box>
			</box>
		</box>
	);
}
