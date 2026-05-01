import { listAgents } from "@backend/agent";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/solid";
import { createMemo, createSignal, Show } from "solid-js";
import { Conversation } from "./components/conversation";
import { DialogAgent } from "./components/dialog-agent";
import {
	type CommandOption,
	CommandProvider,
	useCommand,
} from "./components/dialog-command";
import { DialogModel } from "./components/dialog-model";
import { DialogProvider as DialogProviderSelect } from "./components/dialog-provider";
import { DialogTheme } from "./components/dialog-theme";
import { DialogVariant } from "./components/dialog-variant";
import { OpenPage } from "./components/open-page";
import { Prompt } from "./components/prompt";
import { SecondaryPage } from "./components/secondary-page";
import { SessionList } from "./components/session-list";
import { Sidebar } from "./components/sidebar";
import { AgentProvider, useAgent } from "./context/agent";
import { closeSecondaryPage, getSecondaryPage } from "./context/secondary-page";
import { ThemeProvider, useTheme } from "./context/theme";
import { DialogProvider, useDialog } from "./ui/dialog";
import { Toast, ToastProvider, useToast } from "./ui/toast";
import * as Keybind from "./util/keybind";

let scroll: ScrollBoxRenderable | null = null;
let inputRef: any = null;

export function setScrollRef(ref: ScrollBoxRenderable) {
	scroll = ref;
}

export function setInputRef(ref: any) {
	inputRef = ref;
}

export function refocusInput() {
	if (inputRef && !inputRef.isDestroyed && !inputRef.focused) {
		inputRef.focus();
	}
}

/**
 * Blur the prompt so the session panel can take over keyboard input
 * without double-dispatching keys (arrows, Enter) through both surfaces.
 * Paired with `refocusInput()` on panel close.
 */
export function blurInput() {
	if (inputRef && !inputRef.isDestroyed && inputRef.focused) {
		inputRef.blur();
	}
}

export function toBottom() {
	setTimeout(() => {
		if (!scroll || scroll.isDestroyed) return;
		scroll.scrollTo(scroll.scrollHeight);
	}, 50);
}

export function Layout() {
	const renderer = useRenderer();
	const dialog = useDialog();
	const command = useCommand();
	const toast = useToast();
	const { actions, store, session } = useAgent();
	const { theme, themeId } = useTheme();

	const dimensions = useTerminalDimensions();
	const [sessionListOpen, setSessionListOpen] = createSignal(false);
	// Hide the right metadata sidebar either because the terminal is too
	// narrow or because the session list panel is on the left (giving all
	// remaining width to the conversation).
	const showSidebar = createMemo(
		() => dimensions().width >= 100 && !sessionListOpen(),
	);

	function closeSessionList() {
		setSessionListOpen(false);
		refocusInput();
	}

	// Commands shown in the palette (Ctrl+P) plus any with a `keybind` field
	// are dispatched by `CommandProvider`. Registration is reactive: returning
	// `[]` when a command shouldn't apply (e.g. agent cycling on a non-empty
	// session) removes it both from the palette and from global dispatch.
	command.register(() => {
		const canSwitchAgent = store.messages.length === 0;
		const list: CommandOption[] = [];

		if (canSwitchAgent) {
			list.push({
				id: "agents",
				title: "Agents",
				description: "Switch agent",
				onSelect: (d) => {
					DialogAgent.show(d);
				},
			});
		}

		list.push({
			id: "models",
			title: "Models",
			description: "Switch model",
			onSelect: (d) => {
				DialogModel.show(
					d,
					{
						providerId: session.getProviderId(),
						modelId: session.getModelId(),
					},
					(model) => {
						actions.setModel(model);
					},
				);
			},
		});

		// "Effort" palette entry — standalone switcher for the current
		// model's reasoning level. Only registered when the active model
		// supports reasoning; a non-reasoning model has nothing to pick
		// (the only available level is "off"), so the entry is hidden to
		// avoid palette noise. Mirrors OpenCode's `hidden` flag on the
		// `variant.list` command
		// (`opencode/src/cli/cmd/tui/app.tsx:537`), which is driven by
		// `local.model.variant.list().length === 0`. The `store
		// .modelReasoning` read makes this registration reactive, so
		// switching to/from a reasoning model shows/hides the entry
		// immediately.
		if (store.modelReasoning) {
			list.push({
				id: "effort",
				title: "Effort",
				description: "Reasoning effort",
				onSelect: (d) => {
					DialogVariant.show(
						d,
						session.getModel(),
						session.getThinkingLevel(),
						(level) => {
							actions.setThinkingLevel(level);
						},
					);
				},
			});
		}

		list.push(
			{
				id: "themes",
				title: "Themes",
				description: "Switch theme",
				onSelect: (d) => {
					DialogTheme.show(d, themeId());
				},
			},
			{
				id: "connect",
				title: "Connect",
				description: "Manage providers",
				onSelect: (d) => {
					DialogProviderSelect.show(d, (model) => {
						actions.setModel(model);
					});
				},
			},
			// Shell-level slash verb. Registered here (not on an agent) so
			// every agent inherits it without declaring a `clear` command.
			// Slash dispatch in `prompt.tsx` matches against the unified
			// registry — see SLASH-COMMANDS.md Path A.
			{
				id: "session.clear",
				title: "Clear session",
				description: "Clear the current session",
				slash: { name: "clear" },
				onSelect: () => {
					// Fire-and-forget: `clearSession` is async to await a
					// mid-stream `agent.abort()`, but callers in command
					// palette/slash dispatch don't await. The Promise can't
					// reject (pi-agent-core's `reset()` is synchronous and
					// `waitForIdle()` never throws), so dropping it is safe.
					void actions.clearSession();
				},
			},
			// Keybind-only: Ctrl+N toggles the left session panel. Hidden
			// from the palette (a palette click can't meaningfully "toggle"
			// a panel — it'd just open it, which is misleading).
			{
				id: "session_list",
				title: "Sessions",
				keybind: "session_list",
				hidden: true,
				onSelect: () => {
					if (getSecondaryPage()) return; // no session list while secondary page is open
					if (sessionListOpen()) {
						closeSessionList();
						return;
					}
					if (dimensions().width < 80) {
						toast.show({
							variant: "warning",
							title: "Terminal too narrow",
							message: "Widen the window to open the session panel.",
							duration: 3000,
						});
						return;
					}
					setSessionListOpen(true);
				},
			},
		);

		// Tab / Shift+Tab cycle agents on the open page only. Hidden from the
		// palette (they're keybind-only) and disabled once messages exist.
		if (canSwitchAgent) {
			const cycle = (dir: 1 | -1) => {
				const all = listAgents();
				if (all.length <= 1) return;
				const i = all.findIndex((a) => a.name === store.currentAgent);
				const base = i < 0 ? 0 : i;
				const next = all[(base + dir + all.length) % all.length];
				if (next) actions.selectAgent(next.name);
			};
			list.push(
				{
					id: "agent_cycle",
					title: "Next agent",
					keybind: "agent_cycle",
					hidden: true,
					onSelect: () => cycle(1),
				},
				{
					id: "agent_cycle_reverse",
					title: "Previous agent",
					keybind: "agent_cycle_reverse",
					hidden: true,
					onSelect: () => cycle(-1),
				},
			);
		}

		return list;
	});

	// Bare-metal + scroll keybinds. These don't go through the command
	// registry because:
	//   - `app_exit` destroys the renderer (not a normal "command")
	//   - the scroll targets (`scroll` ref) are local to this Layout and
	//     only meaningful when the session view is mounted
	useKeyboard((evt: any) => {
		if (Keybind.match("app_exit", evt)) {
			// Only exit when no dialog is open — otherwise the dialog stack's
			// handler in `ui/dialog.tsx` treats ctrl+c as "close dialog".
			if (dialog.stack.length > 0) return;
			renderer.destroy();
			// renderer.destroy() restores terminal state; exit the process
			// since pi-agent-core keeps handles alive.
			setTimeout(() => process.exit(0), 100);
			return;
		}

		// ESC / Ctrl+[ — close secondary page and return to conversation.
		// Checked after app_exit but before scroll guards. Gated on no open
		// dialogs so ESC closes a dialog first when one is on the stack.
		if (
			Keybind.match("secondary_page_close", evt) &&
			getSecondaryPage() &&
			dialog.stack.length === 0
		) {
			closeSecondaryPage();
			return;
		}

		if (!scroll || scroll.isDestroyed) return;
		if (dialog.stack.length > 0) return;

		if (Keybind.match("messages_page_up", evt)) {
			scroll.scrollBy(-scroll.height / 2);
			return;
		}
		if (Keybind.match("messages_page_down", evt)) {
			scroll.scrollBy(scroll.height / 2);
			return;
		}
		if (Keybind.match("messages_first", evt)) {
			scroll.scrollTo(0);
			return;
		}
		if (Keybind.match("messages_last", evt)) {
			scroll.scrollTo(scroll.scrollHeight);
			return;
		}
	});

	return (
		<>
			<Show
				when={store.messages.length > 0}
				fallback={
					<box
						flexDirection="row"
						flexGrow={1}
						backgroundColor={theme.background}
					>
						<Show when={sessionListOpen()}>
							<SessionList
								onClose={closeSessionList}
								onSelect={(id) => {
									actions.resumeSession(id);
									closeSessionList();
								}}
							/>
						</Show>
						<box flexGrow={1}>
							<OpenPage />
						</box>
					</box>
				}
			>
				<box
					flexDirection="row"
					flexGrow={1}
					backgroundColor={theme.background}
				>
					{/* Left column: session list panel (Ctrl+N toggle) */}
					<Show when={sessionListOpen()}>
						<SessionList
							onClose={closeSessionList}
							onSelect={(id) => {
								actions.resumeSession(id);
								closeSessionList();
							}}
						/>
					</Show>
					{/* Middle column: conversation + prompt (or secondary page) */}
					{/* Horizontal padding + bottom gap matches OpenCode session/index.tsx:1043 */}
					<Show
						when={!getSecondaryPage()}
						fallback={
							<box flexDirection="column" flexGrow={1} paddingBottom={1}>
								<SecondaryPage />
							</box>
						}
					>
						<box
							flexDirection="column"
							flexGrow={1}
							paddingLeft={2}
							paddingRight={2}
							paddingBottom={1}
						>
							<Conversation />
							<box paddingTop={1} flexShrink={0}>
								<Prompt />
							</box>
						</box>
					</Show>
					{/* Right column: session metadata sidebar (hidden on narrow terminals or when session panel is open) */}
					<Show when={showSidebar()}>
						<Sidebar inSecondaryPage={!!getSecondaryPage()} />
					</Show>
				</box>
			</Show>
			<Toast />
		</>
	);
}

export function App() {
	return (
		<ThemeProvider>
			<ToastProvider>
				<DialogProvider>
					<CommandProvider>
						<AgentProvider>
							<Layout />
						</AgentProvider>
					</CommandProvider>
				</DialogProvider>
			</ToastProvider>
		</ThemeProvider>
	);
}
