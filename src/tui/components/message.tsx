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
}) {
	const { theme } = useTheme();
	const { store } = useAgent();
	const agentColor = () => theme[getAgentInfo(store.currentAgent).colorKey];

	const dangling = () =>
		isDanglingUser(props.message, store.messages, store.isStreaming);

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
			{/* Dangling-user marker — stream was killed mid-turn so no
			    assistant reply followed. We considered OpenCode's
			    `· interrupted` pattern (`routes/session/index.tsx:1420-
			    1422`) but that's a SUFFIX on the assistant footer (agent
			    / model / duration / · interrupted). We don't have real
			    agent/model/duration for a turn that never completed —
			    loadSession's placeholder fills pi-agent-core's slot for
			    provider alternation, but its fields are bland defaults
			    (see buildAbortedAssistant in sessions.ts), not data we'd
			    want rendered. A bare muted line is the honest shape. */}
			<Show when={dangling()}>
				<box paddingLeft={3} paddingTop={1} flexShrink={0}>
					<text fg={theme.textMuted}>[Interrupted by user]</text>
				</box>
			</Show>
		</box>
	);
}

/**
 * A user bubble is "dangling" when it has no real assistant reply
 * following it AND no stream is pending. "Real" means at least one
 * part OR an error — matches the outer `<Show>` gate in the list so
 * an orphan empty-parts assistant (a header row inserted on
 * `message_start` but parts never flushed because `message_end` never
 * fired — a Ctrl+C window) doesn't mask the marker.
 *
 * The `isTail && isStreaming` skip covers the window where
 * `message_start` pushed an assistant bubble but no parts have
 * streamed in yet — that's a pending reply, not an orphan.
 *
 * Pure function: determined entirely by the message + its surrounding
 * list, so it reads cleanly at the bubble level without needing the
 * list to pre-compute and pass the flag down.
 */
function isDanglingUser(
	msg: DisplayMessage,
	messages: DisplayMessage[],
	isStreaming: boolean,
): boolean {
	if (msg.role !== "user") return false;
	const index = messages.indexOf(msg);
	if (index === -1) return false;
	const next = messages[index + 1];
	if (next && next.role === "assistant") {
		const real = next.parts.length > 0 || !!next.error;
		if (real) return false;
		// Ghost assistant header (parts never flushed) — fall through.
	}
	const isTail = index === messages.length - 1;
	if (isTail && isStreaming) return false;
	return true;
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
