/**
 * Message rendering primitives.
 *
 * Each concern gets its own component so the top-level `Conversation`
 * stays a thin list + routing layer. Mirrors OpenCode's split in
 * `routes/session/index.tsx` (`UserMessage`, `AssistantMessage`,
 * `ReasoningPart`, `TextPart`) — trimmed to Inkstone's part types
 * (`text` / `thinking`; tool parts not rendered yet).
 */

import { getAgentInfo } from "@backend/agent";
import type { DisplayMessage } from "@bridge/view-model";
import { Show } from "solid-js";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { formatDuration } from "../util/format";

const EmptyBorder = {
	topLeft: "",
	bottomLeft: "",
	vertical: "",
	topRight: "",
	bottomRight: "",
	horizontal: " ",
	bottomT: "",
	topT: "",
	cross: "",
	leftT: "",
	rightT: "",
};

export const SplitBorderChars = {
	...EmptyBorder,
	vertical: "┃",
};

// ---------------------------------------------------------------------------
// User bubble.
// ---------------------------------------------------------------------------

export function UserMessage(props: {
	message: DisplayMessage;
	first: boolean;
	dangling: boolean;
}) {
	const { theme } = useTheme();
	const { store } = useAgent();
	const agentColor = () => theme[getAgentInfo(store.currentAgent).colorKey];

	return (
		<box flexDirection="column" flexShrink={0}>
			<box
				border={["left"]}
				borderColor={agentColor()}
				customBorderChars={SplitBorderChars}
				marginTop={props.first ? 0 : 1}
			>
				<box
					paddingTop={1}
					paddingBottom={1}
					paddingLeft={2}
					backgroundColor={theme.backgroundPanel}
					flexShrink={0}
				>
					<text fg={theme.text}>{props.message.parts[0]?.text ?? ""}</text>
				</box>
			</box>
			{/* Dangling-user marker: the stored stream was killed mid-turn
                so no real assistant reply followed. Mirrors the load-time
                repair in `loadSession`; the user's typed text stays in
                scrollback while the marker explains why no response is
                beneath. */}
			<Show when={props.dangling}>
				<box paddingLeft={3} paddingTop={1} flexShrink={0}>
					<text fg={theme.textMuted}>[Interrupted by user]</text>
				</box>
			</Show>
		</box>
	);
}

// ---------------------------------------------------------------------------
// Assistant parts (text / thinking).
// ---------------------------------------------------------------------------

export function TextPart(props: {
	text: string;
	first: boolean;
	streaming: boolean;
}) {
	const { theme, syntax } = useTheme();
	return (
		<box paddingLeft={3} marginTop={props.first ? 0 : 1} flexShrink={0}>
			<markdown
				content={props.text}
				syntaxStyle={syntax()}
				streaming={props.streaming}
				fg={theme.text}
				bg={theme.background}
			/>
		</box>
	);
}

/**
 * Mirrors OpenCode's `ReasoningPart` (`routes/session/index.tsx:1437-1468`):
 * single markdown block with an inline `_Thinking:_ ` italic prefix,
 * rendered through `subtleSyntax` so every token is alpha-faded uniformly
 * while preserving per-scope hue. No outer `fg` override — that would
 * flatten all tokens to one color and cancel the per-scope dimming.
 */
export function ReasoningPart(props: {
	text: string;
	first: boolean;
	streaming: boolean;
}) {
	const { theme, subtleSyntax } = useTheme();
	return (
		<box
			paddingLeft={2}
			marginTop={props.first ? 0 : 1}
			border={["left"]}
			borderColor={theme.backgroundElement}
			customBorderChars={SplitBorderChars}
			flexShrink={0}
			flexDirection="column"
		>
			<markdown
				content={`_Thinking:_ ${props.text}`}
				syntaxStyle={subtleSyntax()}
				streaming={props.streaming}
				bg={theme.background}
			/>
		</box>
	);
}

// ---------------------------------------------------------------------------
// Assistant bubble — parts loop + error panel + footer.
// ---------------------------------------------------------------------------

/**
 * `isTailTurn` indicates this message is the absolute last message in
 * the store AND a stream is in flight; the final part in that case is
 * the unstable token-by-token block that pi-ai's markdown parser keeps
 * open. Only that tail gets `streaming={true}`.
 */
export function AssistantMessage(props: {
	message: DisplayMessage;
	isTailTurn: boolean;
}) {
	const { theme } = useTheme();
	const { store } = useAgent();
	const agentColor = () => theme[getAgentInfo(store.currentAgent).colorKey];

	const msg = () => props.message;
	const parts = () => msg().parts;
	const isStreaming = () => store.isStreaming && props.isTailTurn;

	return (
		<box flexDirection="column" flexShrink={0}>
			<box flexDirection="column" flexShrink={0}>
				{parts().map((part, i) => {
					const first = i === 0;
					const streaming = () => isStreaming() && i === parts().length - 1;
					if (part.type === "thinking") {
						return (
							<ReasoningPart
								text={part.text}
								first={first}
								streaming={streaming()}
							/>
						);
					}
					return (
						<TextPart text={part.text} first={first} streaming={streaming()} />
					);
				})}
			</box>

			{/* Assistant-turn error panel. Mirrors OpenCode's per-message
                error box (`routes/session/index.tsx:1374-1387`) — left
                border in theme.error, muted body text. `marginLeft={3}`
                aligns the left edge with the markdown body above. Covers
                both `stopReason === "error"` and `"aborted"`. */}
			<Show when={msg().error}>
				<box
					marginLeft={3}
					marginTop={parts().length > 0 ? 1 : 0}
					border={["left"]}
					borderColor={theme.error}
					customBorderChars={SplitBorderChars}
				>
					<box
						paddingTop={1}
						paddingBottom={1}
						paddingLeft={2}
						backgroundColor={theme.backgroundPanel}
						flexShrink={0}
					>
						<text fg={theme.textMuted}>{msg().error}</text>
					</box>
				</box>
			</Show>

			<Show when={msg().modelName}>
				<box paddingLeft={3} paddingTop={1} flexShrink={0}>
					<text wrapMode="none">
						<span style={{ fg: agentColor() }}>{"▣ "}</span>
						<span style={{ fg: theme.text }}>
							{msg().agentName ?? "Reader"}
						</span>
						<span style={{ fg: theme.textMuted }}>
							{" · "}
							{msg().modelName}
							{durationSuffix(msg().duration)}
						</span>
					</text>
				</box>
			</Show>
		</box>
	);
}

function durationSuffix(ms: number | undefined): string {
	if (ms === undefined || ms <= 0) return "";
	return ` · ${formatDuration(ms)}`;
}
