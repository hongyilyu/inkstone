import { getAgentInfo } from "@backend/agent";
import { getProvider } from "@backend/providers";
import { type RGBA, TextAttributes } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { setInputRef, toBottom } from "../app";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { useDialog } from "../ui/dialog";
import { formatCost, formatTokens } from "../util/format";
import * as Keybind from "../util/keybind";
import { useCommand } from "./dialog-command";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Border chars matching OpenCode's EmptyBorder pattern.
 * All slots empty except horizontal (space) so borders render only where we want.
 */
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

/**
 * Simple braille-dot spinner component.
 * Matches OpenCode's generic Spinner component (spinner.tsx).
 */
function Spinner(props: { color?: RGBA }) {
	const { theme } = useTheme();
	const [frame, setFrame] = createSignal(0);

	onMount(() => {
		const interval = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
		}, 80);
		onCleanup(() => clearInterval(interval));
	});

	return (
		<text fg={props.color ?? theme.textMuted}>{SPINNER_FRAMES[frame()]}</text>
	);
}

/**
 * Unified prompt component used by both the open page and the session view.
 *
 * Structure matches OpenCode's Prompt component (prompt/index.tsx:973-1363):
 *   ┃ [input area]                            │
 *   ┃ Reader · Claude Sonnet 4  Amazon Bedrock│
 *   ╹
 *     [spinner / hints]    [usage / commands]
 */
export function Prompt() {
	const { theme } = useTheme();
	const { actions, store } = useAgent();
	const dialog = useDialog();
	const command = useCommand();
	const [text, setText] = createSignal("");

	// Double-tap ESC to interrupt. Matches OpenCode's pattern
	// (`opencode/src/cli/cmd/tui/component/prompt/index.tsx:273-303, 1325-1330`):
	// first press flips the hint to "esc again to interrupt" in `theme.primary`
	// and arms a 5s reset timer; second press within the window calls
	// `actions.abort()` and resets the counter.
	const [interrupt, setInterrupt] = createSignal(0);
	let interruptTimer: ReturnType<typeof setTimeout> | undefined;

	function handleInterrupt() {
		if (interruptTimer) {
			clearTimeout(interruptTimer);
			interruptTimer = undefined;
		}
		const next = interrupt() + 1;
		setInterrupt(next);
		if (next >= 2) {
			actions.abort();
			setInterrupt(0);
			return;
		}
		interruptTimer = setTimeout(() => {
			setInterrupt(0);
			interruptTimer = undefined;
		}, 5000);
	}

	// Scope the interrupt arm to the current turn. Without this, a single ESC
	// press late in a turn that completes before the 5s timer fires leaves
	// `interrupt === 1`; the next turn's first ESC would then hit the
	// `next >= 2` branch and abort immediately instead of arming the
	// double-tap. Intentional divergence from OpenCode, which carries the
	// same latent bug (prompt/index.tsx:290-294).
	createEffect(() => {
		if (store.isStreaming) return;
		if (interruptTimer) {
			clearTimeout(interruptTimer);
			interruptTimer = undefined;
		}
		setInterrupt(0);
	});

	// Register the interrupt command reactively — gated on `store.isStreaming`
	// so the ESC keybind is live only while a turn is in flight. Mirrors
	// OpenCode's `enabled: status().type !== "idle"`; returning `[]` when
	// inactive removes both the (hidden) palette row and the global dispatch
	// for the keybind. `CommandProvider` already skips when a dialog is on
	// the stack, so ESC inside a dialog still closes the dialog.
	command.register(() => {
		if (!store.isStreaming) return [];
		return [
			{
				id: "session_interrupt",
				title: "Interrupt session",
				keybind: "session_interrupt",
				hidden: true,
				onSelect: handleInterrupt,
			},
		];
	});

	onCleanup(() => {
		if (interruptTimer) clearTimeout(interruptTimer);
	});

	let inputRef: any;

	// Auto-focus: prompt always has focus unless a dialog is open
	// Mirrors OpenCode prompt/index.tsx:469-479
	createEffect(() => {
		const el = inputRef;
		if (!el || el.isDestroyed) return;
		if (dialog.stack.length > 0) {
			if (el.focused) el.blur();
			return;
		}
		if (!el.focused) el.focus();
	});

	function handleSubmit() {
		const value = text().trim();
		if (!value) return;
		if (store.isStreaming) return;

		if (value === "/clear") {
			actions.clearSession();
			setText("");
			return;
		}

		// `/article` is a reader-only command. On any other agent we let the
		// branch fall through so the literal text is sent as a normal prompt.
		// (The prefix check itself is naive — robust slash-command parsing is
		// tracked in docs/TODO.md Future Work.)
		if (store.currentAgent === "reader" && value.startsWith("/article ")) {
			const articleId = value.slice("/article ".length).trim();
			if (articleId) {
				actions.loadArticle(articleId);
				actions.prompt(`Read ${articleId}`);
				setText("");
				toBottom();
				return;
			}
		}

		actions.prompt(value);
		setText("");
		toBottom();
	}

	// Usage display: "68.7K (7%) · $2.25"
	// Matches OpenCode's usage memo (prompt/index.tsx:159-176)
	const usageText = createMemo(() => {
		if (store.totalTokens <= 0) return undefined;
		const tokens = formatTokens(store.totalTokens);
		const pct =
			store.contextWindow > 0
				? ` (${Math.round((store.totalTokens / store.contextWindow) * 100)}%)`
				: "";
		const parts = [tokens + pct];
		if (store.totalCost > 0) {
			parts.push(formatCost(store.totalCost));
		}
		return parts.join(" · ");
	});

	// Current agent info (display name + theme color key). `getAgentInfo`
	// falls back to the default agent for unknown names, so the memo is
	// never undefined.
	const agentInfo = createMemo(() => getAgentInfo(store.currentAgent));

	// Tab-cycle hint only makes sense on a fresh session. Once the user has
	// sent a message the agent is locked for the rest of the session.
	const canCycleAgent = createMemo(() => store.messages.length === 0);

	return (
		<box flexShrink={0}>
			{/* prompt/index.tsx:974-1225 — input area with left border accent.
          The closing ╹ corner lives on the cap row below, not on this box. */}
			<box
				flexShrink={0}
				border={["left"]}
				borderColor={theme[agentInfo().colorKey]}
				customBorderChars={{
					...EmptyBorder,
					vertical: "┃",
				}}
			>
				<box
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					flexShrink={0}
					backgroundColor={theme.backgroundElement}
				>
					<input
						ref={(r: any) => {
							inputRef = r;
							setInputRef(r);
						}}
						value={text()}
						onInput={(v: string) => setText(v)}
						onSubmit={handleSubmit}
						placeholder={
							store.isStreaming
								? "Waiting for response..."
								: "Type a message or /article <filename>..."
						}
						focused
						backgroundColor={theme.backgroundElement}
						focusedBackgroundColor={theme.backgroundElement}
						textColor={theme.text}
						focusedTextColor={theme.text}
						cursorColor={
							store.isStreaming ? theme.backgroundElement : theme.primary
						}
						placeholderColor={theme.textMuted}
					/>
					{/* prompt/index.tsx:1186-1223 — agent/model metadata */}
					<box
						flexDirection="row"
						flexShrink={0}
						paddingTop={1}
						gap={1}
						justifyContent="space-between"
					>
						<box flexDirection="row" gap={1}>
							<text fg={theme[agentInfo().colorKey]}>
								{agentInfo().displayName}
							</text>
							<text fg={theme.textMuted}>·</text>
							<text flexShrink={0} fg={theme.text}>
								{store.modelName}
							</text>
							<text fg={theme.textMuted}>
								{getProvider(store.modelProvider).displayName}
							</text>
							{/* Reasoning effort badge, only when the user has
                                opted into a non-off effort for the active
                                model. Mirrors OpenCode's prompt statusline
                                variant indicator (`prompt/index.tsx:901-906,
                                1204-1211`) — bold + warning-tinted so it
                                reads as a state annotation rather than part
                                of the model name. */}
							<Show when={store.thinkingLevel !== "off"}>
								<text fg={theme.textMuted}>·</text>
								<text fg={theme.warning} attributes={TextAttributes.BOLD}>
									{store.thinkingLevel}
								</text>
							</Show>
						</box>
					</box>
				</box>
			</box>

			{/* prompt/index.tsx:1226-1251 — 1-row cap: ╹ corner on the left, ▀ fill
          across the rest. The ▀ (upper half block) in backgroundElement extends
          the input box's visual bottom by half a row and provides the gap to
          the hints row below. Inkstone's theme backgrounds are always opaque
          (RGBA.fromHex), so we skip OpenCode's alpha-channel conditional. */}
			<box
				height={1}
				border={["left"]}
				borderColor={theme[agentInfo().colorKey]}
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

			{/* prompt/index.tsx:1252-1363 — hints/status row */}
			<box width="100%" flexDirection="row" justifyContent="space-between">
				<Show when={store.isStreaming} fallback={<text />}>
					<box
						flexDirection="row"
						gap={1}
						flexGrow={1}
						justifyContent="flex-start"
					>
						<box flexShrink={0} flexDirection="row" gap={1}>
							<box marginLeft={1}>
								<Spinner color={theme.textMuted} />
							</box>
						</box>
						<text fg={interrupt() > 0 ? theme.primary : theme.text}>
							esc{" "}
							<span
								style={{
									fg: interrupt() > 0 ? theme.primary : theme.textMuted,
								}}
							>
								{interrupt() > 0 ? "again to interrupt" : "interrupt"}
							</span>
						</text>
					</box>
				</Show>
				<box gap={2} flexDirection="row">
					<Show when={usageText()}>
						<text fg={theme.textMuted} wrapMode="none">
							{usageText()}
						</text>
					</Show>
					<Show when={canCycleAgent()}>
						<text fg={theme.text}>
							{Keybind.print("agent_cycle")}{" "}
							<span style={{ fg: theme.textMuted }}>agents</span>
						</text>
					</Show>
					<text fg={theme.text}>
						{Keybind.print("command_list")}{" "}
						<span style={{ fg: theme.textMuted }}>commands</span>
					</text>
				</box>
			</box>
		</box>
	);
}
