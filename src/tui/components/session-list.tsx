import {
	listSessions,
	type SessionSummary,
} from "@backend/persistence/sessions";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { blurInput } from "../app";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { formatRelativeTime } from "../util/format";
import * as Keybind from "../util/keybind";

const PANEL_WIDTH = 34;
// Inner content width = PANEL_WIDTH - paddingLeft(2) - paddingRight(2)
const TITLE_MAX_CHARS = PANEL_WIDTH - 4;

export interface SessionListProps {
	onSelect(sessionId: string): void;
	onClose(): void;
}

/**
 * Left-side panel listing past sessions for the current agent. Ctrl+R
 * toggles this panel on; Enter on a selected row calls `onSelect`, which
 * the layout wires to `actions.resumeSession`.
 *
 * Scoping: the list is filtered to `store.currentAgent` — cross-agent
 * browsing would require a swap that breaks D13 (agent-for-session),
 * so we simply don't offer it.
 *
 * The keyboard handler matches the subset of DialogSelect's nav (up /
 * down / enter / esc / ctrl+r). We deliberately skip the fuzzy filter,
 * mouse input-mode tracking, and page-up / page-down from DialogSelect —
 * the session list's shape (small, flat, visible-when-you-opened-it)
 * doesn't need them. If that stops being true, refactor toward a
 * panel-variant of DialogSelect rather than letting this file grow.
 */
export function SessionList(props: SessionListProps) {
	const { theme } = useTheme();
	const { store, session } = useAgent();

	// Snapshot taken on mount. The panel re-mounts on every open (see
	// `<Show when={sessionListOpen()}>` in app.tsx), so a closed-then-
	// reopened panel always sees a fresh listing without needing a
	// subscription surface.
	const [rows] = createSignal<SessionSummary[]>(
		listSessions(store.currentAgent),
	);

	// Blur the prompt input while the panel is mounted so this component's
	// `useKeyboard` has exclusive claim to nav keys. Without this, pressing
	// Enter with the panel open would both submit the prompt and resume the
	// selected session; Up/Down would also move the prompt caret and the
	// panel selection simultaneously. The parent's `closeSessionList` calls
	// `refocusInput()` on dismiss, so focus round-trips cleanly.
	onMount(() => {
		blurInput();
	});

	const [navStore, setNavStore] = createStore({ selected: 0 });

	const selectedRow = createMemo(() => rows()[navStore.selected]);

	function moveTo(idx: number) {
		const list = rows();
		if (list.length === 0) return;
		let next = idx;
		if (next < 0) next = list.length - 1;
		if (next >= list.length) next = 0;
		setNavStore("selected", next);
	}

	function move(dir: number) {
		moveTo(navStore.selected + dir);
	}

	function submit() {
		const row = selectedRow();
		if (!row) return;
		props.onSelect(row.id);
	}

	useKeyboard((evt: any) => {
		// Close check runs FIRST because `panel_close` includes `ctrl+n`,
		// which is also an alternate of `select_down`. If we checked
		// `select_down` first, ctrl+n while the panel is open would move
		// the selection instead of closing — the opposite of what the
		// user expects when they press the open-key again.
		//
		// ESC overlap: `session_interrupt` is also ESC, registered by
		// prompt.tsx while streaming. If the user opens the panel during
		// a streaming turn and presses ESC, both handlers fire — this
		// one closes the panel, `session_interrupt`'s double-tap arms
		// (first press). Harmless: the interrupt state auto-resets after
		// 5s, and `resumeSession` already guards on `isStreaming`, so no
		// state can be mutated through the panel mid-stream.
		if (Keybind.match("panel_close", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			props.onClose();
			return;
		}
		if (Keybind.match("select_up", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(-1);
			return;
		}
		if (Keybind.match("select_down", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(1);
			return;
		}
		if (Keybind.match("select_first", evt)) {
			evt.preventDefault?.();
			moveTo(0);
			return;
		}
		if (Keybind.match("select_last", evt)) {
			evt.preventDefault?.();
			moveTo(rows().length - 1);
			return;
		}
		if (Keybind.match("select_submit", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			submit();
			return;
		}
	});

	// `getCurrentSessionId` reads a plain `let` in the AgentProvider
	// closure — not a signal. Wrap as a plain accessor (not `createMemo`)
	// so we don't imply reactivity that doesn't exist. The `●` indicator
	// refreshes on panel re-mount, which is enough for today's UX:
	// resume flow closes the panel before mutating `currentSessionId`,
	// so the indicator always reflects the latest value on next open.
	const currentSessionId = () => session.getCurrentSessionId();

	return (
		<box
			width={PANEL_WIDTH}
			flexShrink={0}
			flexDirection="column"
			backgroundColor={theme.backgroundPanel}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			{/* Header */}
			<box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
				<text fg={theme.text} attributes={TextAttributes.BOLD}>
					Sessions
				</text>
				<text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
					{Keybind.print("session_list")}
				</text>
			</box>

			<Show
				when={rows().length > 0}
				fallback={<text fg={theme.textMuted}>No past sessions</text>}
			>
				<scrollbox scrollbarOptions={{ visible: false }} flexGrow={1}>
					<For each={rows()}>
						{(row, i) => {
							const active = createMemo(() => i() === navStore.selected);
							const current = createMemo(() => row.id === currentSessionId());
							return (
								<box
									flexDirection="column"
									backgroundColor={
										active() ? theme.primary : theme.backgroundPanel
									}
									paddingLeft={current() ? 0 : 2}
									paddingRight={1}
									paddingTop={0}
									paddingBottom={0}
									marginBottom={1}
									onMouseUp={() => {
										setNavStore("selected", i());
										// Click-to-select fires immediately instead of
										// requiring a second Enter; matches DialogSelect.
										props.onSelect(row.id);
									}}
									onMouseOver={() => setNavStore("selected", i())}
								>
									<box flexDirection="row" gap={1}>
										<Show when={current()}>
											<text
												flexShrink={0}
												fg={
													active() ? theme.selectedListItemText : theme.primary
												}
											>
												●
											</text>
										</Show>
										<text
											flexGrow={1}
											fg={
												active()
													? theme.selectedListItemText
													: current()
														? theme.primary
														: theme.text
											}
											attributes={active() ? TextAttributes.BOLD : undefined}
											wrapMode="none"
											overflow="hidden"
										>
											{truncate(rowTitle(row), TITLE_MAX_CHARS)}
										</text>
									</box>
									<text
										fg={active() ? theme.selectedListItemText : theme.textMuted}
										wrapMode="none"
									>
										{formatRelativeTime(row.startedAt)} · {row.messageCount} msg
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

function rowTitle(row: SessionSummary): string {
	const t = row.title?.trim();
	if (t) return t;
	if (row.preview) return row.preview;
	return "Untitled";
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
