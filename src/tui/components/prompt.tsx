import { getAgentInfo } from "@backend/agent";
import { getProvider } from "@backend/providers";
import type { TextareaRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { clearInputRef, setInputRef, toBottom } from "../app";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { useDialog } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { formatCost, formatTokens } from "../util/format";
import * as Keybind from "../util/keybind";
import {
	buildMentionPayload,
	expandMentionsToPaths,
	type Mention,
	readFileSafe,
} from "../util/mentions";
import { useCommand } from "./dialog/command";
import { PromptAutocomplete } from "./prompt-autocomplete";
import { SpinnerWave } from "./spinner-wave";

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
 * Unified prompt component used by both the open page and the session view.
 *
 * Structure matches OpenCode's Prompt component (prompt/index.tsx:973-1363):
 *   ┃ [input area]                            │
 *   ┃ Reader · Claude Sonnet 4  Amazon Bedrock│
 *   ╹
 *     [spinner / hints]    [usage / commands]
 */
export function Prompt() {
	const { theme, syntax } = useTheme();
	const { actions, store } = useAgent();
	const dialog = useDialog();
	const command = useCommand();
	const toast = useToast();
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
	// for the keybind. `CommandProvider`'s dispatch is suspended while any
	// dialog is open, so ESC inside a dialog still closes the dialog.
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

	let inputRef: TextareaRenderable | undefined;

	/**
	 * Extmark type id for prompt mentions — registered once per mount on
	 * the input buffer. Mentions are created as virtual extmarks with
	 * `typeId: promptPartTypeId` so `input.extmarks.getAllForTypeId` at
	 * submit returns exactly the mention spans (not, e.g., pasted-text
	 * marks future work might add). 0 means "not yet registered" (the
	 * `<input>` ref fires post-render).
	 */
	let promptPartTypeId = 0;

	/**
	 * Style id for `extmark.file` resolved against the currently-active
	 * `SyntaxStyle`. Re-computed on theme switch because `syntax()` is a
	 * memo that recreates the `SyntaxStyle` instance (and its style ids)
	 * when the theme id changes. Extmarks already on the buffer keep
	 * their stored `styleId` field; OpenTUI resolves the style from the
	 * current `SyntaxStyle` at paint time, so live spans repaint in the
	 * new theme without explicit re-creation.
	 */
	const fileStyleId = createMemo(() => syntax().getStyleId("extmark.file"));

	// Auto-focus: prompt always has focus unless a dialog is open.
	// Mirrors OpenCode prompt/index.tsx:469-479.
	//
	// Reactive sources: `dialog.stack.length` drives blur-on-open /
	// refocus-on-close. The ref-callback below focuses on mount, so this
	// effect doesn't need to handle first-focus — it only has to react
	// to dialog-stack changes. This matters because `inputRef` is a
	// plain `let` binding (not a signal); Solid doesn't re-run effects
	// when non-reactive locals change, so "focus when the ref finally
	// populates" must happen inside the ref callback.
	createEffect(() => {
		const el = inputRef as any;
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

		// Read mention extmarks once, up front. Both the slash-dispatch
		// branch and the plain-prompt branch consume them — slash expands
		// `@path` spans to absolute paths so a command like `/article
		// @foo.md` sees its args as `/abs/vault/foo.md` instead of the
		// literal `@foo.md` that would fail downstream. Extmarks come
		// back in INSERTION order, not position order, so the sort is
		// load-bearing.
		const rawText = text();
		const input = inputRef;
		const mentions: Mention[] =
			input && promptPartTypeId
				? input.extmarks
						.getAllForTypeId(promptPartTypeId)
						.map((e: any) => {
							const meta = input.extmarks.getMetadataFor(e.id);
							return meta?.path
								? { start: e.start, end: e.end, path: meta.path as string }
								: null;
						})
						.filter((m: Mention | null): m is Mention => m !== null)
						.sort((a: Mention, b: Mention) => a.start - b.start)
				: [];

		// Slash-command dispatch via the unified command registry.
		// Splits on the first space: `/name args...`. Matching OpenCode's
		// prompt submit path, only entries whose `slash` field matches
		// are intercepted; unknown slashes or commands missing required
		// args fall through as plain prompts.
		//
		// Per SLASH-COMMANDS.md Path A, agent-declared commands and
		// shell-level commands share the same registry; `triggerSlash`
		// resolves them uniformly. Agent-bridge registrations register
		// first so agent-scoped slashes beat shell-scoped on name
		// collision — preserves the D9 "agent overrides built-in" rule.
		//
		// Strict start-of-buffer gate: the raw textarea contents (NOT
		// the trimmed `value`) must begin with `/` for the dispatch to
		// fire. Buffers like `  /clear` or `\n/clear` fall through as
		// plain prompts — mirrors the autocomplete dropdown's open rule
		// (`t.startsWith("/")` in `prompt-autocomplete.tsx`) and the
		// coaching-hint memo, so open / dispatch / hint agree on one
		// rule. Narrows the dispatch surface so a user who pastes a
		// leading-whitespace message that happens to contain `/clear`
		// can't accidentally wipe a session.
		//
		// Mentions inside the args range are expanded to their absolute
		// vault paths BEFORE the dispatch. Mentions entirely before the
		// first space (inside the verb `/name`) stay as literal text in
		// the buffer — `canRunSlash` will fail to match the mangled name
		// and the input falls through as a plain prompt. Trailing text
		// after a mention (e.g. `/article @foo.md junk`) is passed
		// through verbatim to the command; reader's error message is
		// clear enough for a rare user-input bug.
		if (rawText.startsWith("/")) {
			const spaceAt = rawText.indexOf(" ");
			const name =
				spaceAt === -1 ? rawText.slice(1).trim() : rawText.slice(1, spaceAt);
			if (spaceAt === -1) {
				// Bare `/name` with no whitespace after — no mentions in args range.
				if (command.triggerSlash(name, "")) {
					clearInput();
					toBottom();
					return;
				}
			} else {
				const argsStart = spaceAt + 1;
				const argsText = rawText.slice(argsStart);
				const argsMentions: Mention[] = mentions
					.filter((m) => m.start >= argsStart)
					.map((m) => ({
						start: m.start - argsStart,
						end: m.end - argsStart,
						path: m.path,
					}));
				const expanded = expandMentionsToPaths(argsText, argsMentions).trim();
				if (command.triggerSlash(name, expanded)) {
					clearInput();
					toBottom();
					return;
				}
			}
		}

		// Plain-prompt path: inline mention content via `buildMentionPayload`
		// (same format as reader's `/article` for LLM-facing text; the user
		// bubble gets compact `[md] path` chips via `displayParts`).
		const { llmText, displayParts, failed } = buildMentionPayload(
			rawText,
			mentions,
			readFileSafe,
		);

		if (failed.length > 0) {
			toast.show({
				variant: "warning",
				message: `Could not read ${failed.length} file${failed.length === 1 ? "" : "s"}`,
			});
		}

		void actions.prompt(llmText, displayParts);
		clearInput();
		toBottom();
	}

	/**
	 * Clear the textarea buffer AND its extmarks. `input.setText("")`
	 * routes through `ExtmarksController.wrapSetText` which clears all
	 * extmarks as a side effect, so an explicit `extmarks.clear()` is
	 * redundant. The JS signal resets explicitly too because the
	 * textarea is uncontrolled — `onContentChange` would fire
	 * eventually, but handleSubmit's subsequent re-renders read `text()`
	 * so we sync it now to keep them consistent.
	 */
	function clearInput() {
		if (inputRef) inputRef.setText("");
		setText("");
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

	// Post-select coaching hint for slash commands. Shown only when the
	// buffer is exactly `/<name> ` (verb + trailing space, no args yet)
	// AND the matching command has `argGuide` set. `argHint` (the palette
	// placeholder) is intentionally NOT a fallback — the two fields have
	// distinct jobs; see SlashSpec JSDoc.
	//
	// Reactivity: depends on `text()` and `store.currentAgent` (via
	// `command.findSlash` → registry → BridgeAgentCommands re-registers
	// on agent switch). `store.isStreaming` gates it off mid-turn so the
	// hint doesn't linger while the user watches a response arrive.
	const guideInfo = createMemo(() => {
		if (store.isStreaming) return null;
		const t = text();
		if (!t.startsWith("/")) return null;
		const spaceAt = t.indexOf(" ");
		if (spaceAt === -1) return null; // still typing the name
		if (t.slice(spaceAt + 1).length > 0) return null; // typing args
		const name = t.slice(1, spaceAt);
		const entry = command.findSlash(name);
		return entry?.slash?.argGuide ?? null;
	});

	// Tab-cycle hint only makes sense on a fresh session. Once the user has
	// sent a message the agent is locked for the rest of the session.
	const canCycleAgent = createMemo(() => store.messages.length === 0);

	return (
		<box flexShrink={0} position="relative">
			<PromptAutocomplete
				text={text()}
				setText={setText}
				input={() => inputRef}
				promptPartTypeId={() => promptPartTypeId}
				fileStyleId={() => fileStyleId() ?? null}
			/>
			{/* prompt/index.tsx:974-1225 — input area with left border accent.
          The closing ╹ corner lives on the cap row below, not on this box.
          `flexGrow={1}` on both boxes (outer border + inner padded) so the
          bubble fills available width — otherwise the background hugs
          the text and the right side reads as empty terminal. Matches
          OpenCode prompt/index.tsx:988. */}
			<box
				flexShrink={0}
				flexGrow={1}
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
					flexGrow={1}
					backgroundColor={theme.backgroundElement}
				>
					{/* `<textarea>` not `<input>` so overflowing text wraps
					    to the next line instead of horizontally scrolling
					    inside a single-line viewport. OpenCode uses the
					    same shape (`prompt/index.tsx:990` — textarea with
					    minHeight=1, maxHeight=6). `wrapMode="word"` is
					    the default but spelling it out makes the intent
					    explicit. `onContentChange` replaces `onInput` —
					    `<input>` emits INPUT via Solid's `onInput` prop,
					    but `<textarea>` exposes content changes via the
					    core EditBufferRenderable `content-changed`
					    event, surfaced as `onContentChange`.
					    `<input>` hard-codes Enter/Linefeed → submit, but
					    `<textarea>` needs that wiring explicit via
					    `keyBindings` — without this, Enter inserts a
					    newline and `onSubmit` never fires. Keep the
					    textarea defaults for move/delete/word-boundary
					    etc. by appending our two bindings via spread in
					    the core (see `Textarea.ts`'s default bindings)
					    and relying on the fact that the renderable
					    merges user bindings with its own — so we only
					    need to name the submit triggers here. */}
					{/* Textarea + inline coaching hint on the same row.
					    The hint is a muted trailing annotation (right of the
					    textarea) shown when the buffer is exactly `/<name> `
					    and the command sets `argGuide`. `flexDirection="row"`
					    aligns the hint with the textarea's first row; the
					    textarea owns its own growth (`minHeight=1, maxHeight=6`)
					    so the hint stays anchored to the top row even when the
					    textarea grows — which is fine because the hint only
					    appears while the buffer is a single verb + space (one
					    row of content). Reader's `/article` uses this to point
					    at the `@`-mention flow + bare-picker fallback. */}
					<box flexDirection="row" flexShrink={0} flexGrow={1}>
						<box flexShrink={1} flexGrow={1}>
							<textarea
								ref={(r: TextareaRenderable) => {
									inputRef = r;
									setInputRef(r);
									// Register the prompt-mention extmark type once per
									// mount. Returns a stable numeric id usable until
									// the input is destroyed.
									promptPartTypeId = r.extmarks.registerType("prompt-mention");
									onCleanup(() => clearInputRef(r));
								}}
								minHeight={1}
								maxHeight={6}
								wrapMode="word"
								keyBindings={[
									// Plain Enter submits. Every other Enter variant
									// and Ctrl+J inserts a newline — mirrors OpenCode's
									// `input_newline: shift+return, ctrl+return,
									// alt+return, ctrl+j` config. OpenTUI parses Ctrl+J
									// as the `linefeed` key, so we do NOT bind
									// `linefeed → submit` (as `<input>` does by default)
									// — that'd hijack Ctrl+J and collide with the
									// explicit newline binding below.
									{ name: "return", action: "submit" },
									{ name: "return", shift: true, action: "newline" },
									{ name: "return", ctrl: true, action: "newline" },
									{ name: "return", meta: true, action: "newline" },
									{ name: "j", ctrl: true, action: "newline" },
								]}
								onContentChange={() => {
									if (inputRef) setText(inputRef.plainText);
								}}
								onSubmit={handleSubmit}
								placeholder={
									store.isStreaming
										? "Waiting for response..."
										: "Type a message or /article <filename>..."
								}
								focused
								// Syntax style drives extmark highlighting — without it,
								// `styleId`s on extmarks have no palette to resolve
								// against and spans render in the default text color.
								// Same `SyntaxStyle` instance used by the markdown
								// renderer; the shared `extmark.file` rule in
								// `getSyntaxRules` is what paints the `@path` span.
								syntaxStyle={syntax()}
								backgroundColor={theme.backgroundElement}
								focusedBackgroundColor={theme.backgroundElement}
								textColor={theme.text}
								focusedTextColor={theme.text}
								cursorColor={
									store.isStreaming ? theme.backgroundElement : theme.primary
								}
								placeholderColor={theme.textMuted}
							/>
						</box>
						<Show when={guideInfo()}>
							{(guide: () => string) => (
								<box flexShrink={0} paddingLeft={2}>
									<text fg={theme.textMuted} wrapMode="none">
										{guide()}
									</text>
								</box>
							)}
						</Show>
					</box>
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
							{/* Show the provider display name only when a
                                registered provider backs `modelProvider`.
                                Under registry drift (session restored
                                against a stale providerId after a provider
                                drop) the lookup returns undefined and we
                                render model-only — better than a trailing
                                empty separator. */}
							<Show when={getProvider(store.modelProvider)?.displayName}>
								{(name) => <text fg={theme.textMuted}>{name() as string}</text>}
							</Show>
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
							{/* Codex transport indicator — ephemeral (live only,
                                not persisted, not stamped onto DisplayMessage).
                                Rendered as a muted suffix next to the model name
                                so users know whether pi-ai's `"auto"` transport
                                landed on WebSocket (ws; `websocket-cached`
                                continuation is active) or fell back to SSE.
                                The previous one-shot toast surface was pulled in
                                favor of this always-visible badge — transport
                                choice is a network-state signal that should
                                reflect the current reality, not interrupt the
                                user once and disappear. Hidden when the active
                                provider isn't Codex or before the first Codex
                                turn in the session has completed. */}
							<Show when={store.codexTransport}>
								<text fg={theme.textMuted}>·</text>
								<text fg={theme.textMuted}>{store.codexTransport}</text>
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
								<SpinnerWave color={theme[agentInfo().colorKey]} />
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
