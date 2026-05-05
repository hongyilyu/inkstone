/**
 * Message rendering primitives.
 *
 * Each concern gets its own component so the top-level `Conversation`
 * stays a thin list + routing layer. Mirrors OpenCode's split in
 * `routes/session/index.tsx` (`UserMessage`, `AssistantMessage`,
 * `ReasoningPart`, `TextPart`, `ToolPart`) — trimmed to Inkstone's
 * part types (`text` / `thinking` / `file` / `tool`).
 */

import { getAgentInfo } from "@backend/agent";
import { renderToolArgs } from "@bridge/tool-renderers";
import type { DisplayMessage, DisplayPart } from "@bridge/view-model";
import type { RGBA } from "@opentui/core";
import { For, Index, Match, Show, Switch } from "solid-js";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { formatDuration } from "../util/format";
import { UserPart } from "./user-part";

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

// Exported for panel components that want the same empty-border scaffold
// with a custom vertical glyph (e.g. the Phase-5 PermissionPrompt).
export { EmptyBorder };

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
					paddingRight={2}
					flexGrow={1}
					backgroundColor={theme.backgroundPanel}
					flexShrink={0}
					flexDirection="column"
				>
					<For each={props.message.parts}>
						{(part, i) => (
							<UserPart
								part={part}
								first={i() === 0}
								agentColor={agentColor()}
							/>
						)}
					</For>
				</box>
			</box>
			{/* Interrupted-user marker — the reducer stamps
			    `interrupted: true` on the user bubble at `agent_end`
			    when the turn ended without a real assistant reply
			    (abort, crash, etc.). Driven by data, not render-time
			    derivation, so there's no race window. */}
			<Show when={props.message.interrupted}>
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

/**
 * Inline tool-call display. One muted line per tool invocation — mirrors
 * OpenCode's `InlineTool` pattern (`routes/session/index.tsx`) trimmed
 * to Inkstone's scope.
 *
 * State → visual:
 *   - `pending`    : `~ tool args` (muted, no icon yet — result unknown)
 *   - `completed`  : `⚙ tool args` (muted)
 *   - `error`      : `⚙ tool args` in error color + red error line below
 *
 * The args summary is the whole story for today's tools — every
 * `update_sidebar`/`read`/`edit`/`write` result is redundant with the
 * args. Only failures get a second line. When a future tool's result
 * carries information the args don't (e.g. `grep` match count), revisit.
 *
 * Phase-4/Phase-2A diff preview: when a `confirmDirs` approval carries a
 * unified-diff preview, the preview registry (`preview-registry.ts`)
 * stores the diff keyed by `callId`. Auto-expanded while the approval
 * is pending; collapsed when it resolves. For resolved tool calls
 * that have an archived diff, a `▸` / `▾` chevron on the header
 * toggles expansion. The whole header row is the click target — not
 * just the chevron glyph — so users don't have to aim at a 1-cell
 * bullseye in the terminal. When no archived preview exists, the
 * chevron is omitted entirely and the header has no click handler.
 * Themed with the phase-1 diff tokens.
 */
export function ToolPart(props: {
	callId: string;
	name: string;
	args: unknown;
	state: "pending" | "completed" | "error";
	error?: string;
	first: boolean;
}) {
	const { theme } = useTheme();
	const { previews } = useAgent();
	const argsSummary = () => renderToolArgs(props.name, props.args);
	const icon = () => (props.state === "pending" ? "~" : "⚙");
	const headerFg = () =>
		props.state === "error" ? theme.error : theme.textMuted;
	// One registry read per render. `showChevron` gates the
	// disclosure glyph + click handler; `diff` gates the diff
	// body. The two are independent: collapsed-but-archived is
	// `{ diff: undefined, showChevron: true }`.
	const state = () => previews.state(props.callId);
	const chevron = () => (state().diff ? "▾" : "▸");
	return (
		<box
			paddingLeft={3}
			marginTop={props.first ? 0 : 1}
			flexShrink={0}
			flexDirection="column"
		>
			<box
				flexDirection="row"
				flexShrink={0}
				onMouseUp={
					state().showChevron ? () => previews.toggle(props.callId) : undefined
				}
			>
				<text wrapMode="none">
					<Show when={state().showChevron}>
						<span style={{ fg: theme.textMuted }}>{chevron()} </span>
					</Show>
					<span style={{ fg: headerFg() }}>
						{icon()} {props.name}
					</span>
					<Show when={argsSummary()}>
						<span style={{ fg: theme.textMuted }}> {argsSummary()}</span>
					</Show>
				</text>
			</box>
			<Show when={props.state === "error" && props.error}>
				<text fg={theme.error} wrapMode="none">
					{"  "}
					{props.error}
				</text>
			</Show>
			<Show when={state().diff}>
				{(p) => (
					<box
						marginTop={1}
						maxHeight={15}
						flexShrink={0}
						flexDirection="column"
					>
						<diff
							diff={p().unifiedDiff}
							view="unified"
							showLineNumbers={true}
							wrapMode="word"
							fg={theme.text}
							addedBg={theme.diffAddedBg}
							removedBg={theme.diffRemovedBg}
							contextBg={theme.diffContextBg}
							addedSignColor={theme.diffHighlightAdded}
							removedSignColor={theme.diffHighlightRemoved}
							lineNumberFg={theme.diffLineNumber}
							lineNumberBg={theme.diffContextBg}
							addedLineNumberBg={theme.diffAddedLineNumberBg}
							removedLineNumberBg={theme.diffRemovedLineNumberBg}
						/>
					</box>
				)}
			</Show>
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
				{/* Parts list iterated via `<Index>` (not `<For>` and not
				    `parts().map(...)`). During a streaming turn the
				    reducer mutates existing parts in place — a text
				    delta extends `parts[tail].text`, a tool result
				    flips `parts[k].state` from `pending` to
				    `completed`. `<For>` keys by identity and would
				    tear down + recreate every child on each mutation;
				    a plain `.map()` would do the same and also break
				    Solid's reconciliation entirely. `<Index>` keeps
				    each slot's component instance alive and updates
				    only the child whose accessor fires, which is
				    exactly what the streaming `<markdown>` render
				    relies on for its incremental parse path. Parts
				    are append-only within a message (index `i` always
				    refers to the same logical part), so `<Index>`
				    semantics match the data. */}
				<Index each={parts()}>
					{(part, i) => {
						const first = i === 0;
						const streaming = () => isStreaming() && i === parts().length - 1;
						return (
							<Switch>
								<Match when={part().type === "thinking"}>
									<ReasoningPart
										text={
											(part() as Extract<DisplayPart, { type: "thinking" }>)
												.text
										}
										first={first}
										streaming={streaming()}
									/>
								</Match>
								<Match when={part().type === "text"}>
									<TextPart
										text={
											(part() as Extract<DisplayPart, { type: "text" }>).text
										}
										first={first}
										streaming={streaming()}
									/>
								</Match>
								<Match when={part().type === "tool"}>
									{(() => {
										const t = part() as Extract<DisplayPart, { type: "tool" }>;
										return (
											<ToolPart
												callId={t.callId}
												name={t.name}
												args={t.args}
												state={t.state}
												error={t.error}
												first={first}
											/>
										);
									})()}
								</Match>
								{/* `file` parts only live on user bubbles (see
								    `UserMessage`). Assistant bubbles never
								    receive them from the reducer, but the
								    part union covers the whole DisplayPart
								    set — omit a `Match` for it and
								    `<Switch>` renders nothing. */}
							</Switch>
						);
					}}
				</Index>
			</box>

			{/* Assistant-turn error panel. Mirrors OpenCode's per-message
                error box (`routes/session/index.tsx:1374-1387`) — left
                border in theme.error, muted body text. `marginLeft={3}`
                aligns the left edge with the markdown body above. ONLY
                shown for hard errors (`stopReason === "error"`); user-
                initiated aborts are signalled via the `interrupted`
                flag and rendered as a muted footer suffix below. */}
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

			{/* Footer — agent + model + duration, plus a trailing
			    ` · interrupted` suffix on aborted turns. See
			    `AssistantFooter` below for full semantics. */}
			<AssistantFooter message={msg()} agentColor={agentColor()} />
		</box>
	);
}

/**
 * Footer row for an assistant bubble — agent glyph + name + optional
 * model/duration/effort segment + optional `· interrupted` suffix when
 * the user aborted the turn (ESC-ESC or Ctrl+C). On abort the glyph
 * tints `textMuted` to visually differentiate from normal completion.
 * The model/duration segment is only shown if `modelName` is stamped
 * (a very fast abort may never reach `message_end`, leaving it unset —
 * the footer still renders the bare `▣ Reader · interrupted` form so
 * the interrupt is visible). Hidden entirely when the message has
 * neither `modelName` nor `interrupted` set (the streaming shell
 * before `message_end` lands).
 *
 * Mirrors OpenCode's `MessageAbortedError` branch. Extracted from
 * `AssistantMessage` purely to keep the bubble body readable; stays
 * co-located in this module because it reads the same `DisplayMessage`
 * shape and shares no state with any other consumer.
 */
function AssistantFooter(props: { message: DisplayMessage; agentColor: RGBA }) {
	const { theme } = useTheme();
	const msg = () => props.message;
	return (
		<Show when={msg().modelName || msg().interrupted}>
			<box paddingLeft={3} paddingTop={1} flexShrink={0}>
				<text wrapMode="none">
					<span
						style={{
							fg: msg().interrupted ? theme.textMuted : props.agentColor,
						}}
					>
						{"▣ "}
					</span>
					<span style={{ fg: theme.text }}>{msg().agentName ?? "Reader"}</span>
					<Show when={msg().modelName}>
						<span style={{ fg: theme.textMuted }}>
							{" · "}
							{msg().modelName}
							{durationSuffix(msg().duration)}
						</span>
					</Show>
					{/* Effort badge — mirrors the prompt statusline shape
					    (`· <level>` in theme.warning + bold). Hidden when
					    the stamp is `"off"` or absent: historical bubbles
					    from before this field was added have no stamp, and
					    we deliberately don't persist `"off"` because it
					    would render identically to the absent case. */}
					<Show when={msg().thinkingLevel && msg().thinkingLevel !== "off"}>
						<span style={{ fg: theme.textMuted }}>{" · "}</span>
						<strong style={{ fg: theme.warning }}>{msg().thinkingLevel}</strong>
					</Show>
					<Show when={msg().interrupted}>
						<span style={{ fg: theme.textMuted }}> · interrupted</span>
					</Show>
				</text>
			</box>
		</Show>
	);
}

function durationSuffix(ms: number | undefined): string {
	if (ms === undefined || ms <= 0) return "";
	return ` · ${formatDuration(ms)}`;
}
