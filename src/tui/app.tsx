import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, ErrorBoundary, Show } from "solid-js";
import { registerLayoutCommands } from "./commands/layout-commands";
import { Conversation } from "./components/conversation";
import { CommandProvider } from "./components/dialog/command";
import {
	pendingDisconnect,
	respondDisconnect,
} from "./components/disconnect-confirmation";
import { NoProviderFallback } from "./components/no-provider-fallback";
import { OpenPage } from "./components/open-page";
import { PermissionPrompt } from "./components/permission-prompt";
import { Prompt } from "./components/prompt";
import { PromptDraftBridge } from "./components/prompt-draft-bridge";
import { SecondaryPage } from "./components/secondary-page";
import { SessionList } from "./components/session-list";
import { Sidebar } from "./components/sidebar";
import { SuggestCommandPrompt } from "./components/suggest-command-prompt";
import { AgentProvider, useAgent } from "./context/agent";
import { LayoutProvider, useLayout } from "./context/layout";
import { getSecondaryPage } from "./context/secondary-page";
import { ThemeProvider, useTheme } from "./context/theme";
import { useLayoutKeybinds } from "./hooks/use-layout-keybinds";
import { DialogProvider } from "./ui/dialog";
import { Toast, ToastProvider } from "./ui/toast";

export function Layout() {
	const {
		actions,
		store,
		pendingApproval,
		respondApproval,
		pendingSuggestion,
	} = useAgent();
	const { theme } = useTheme();
	const layout = useLayout();
	const dimensions = useTerminalDimensions();
	const [sessionListOpen, setSessionListOpen] = createSignal(false);
	// Hide the right metadata sidebar either because the terminal is
	// too narrow or because the session list panel is on the left
	// (giving all remaining width to the conversation).
	const showSidebar = createMemo(
		() => dimensions().width >= 100 && !sessionListOpen(),
	);

	function closeSessionList() {
		setSessionListOpen(false);
		layout.focusInput();
	}

	registerLayoutCommands({
		sessionListOpen,
		setSessionListOpen,
		closeSessionList,
	});

	useLayoutKeybinds();

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
					{/*
					 * Per-session prompt-draft bridge. Mounts only when the
					 * conversation view is visible — `messages.length > 0`
					 * (this branch) AND no secondary page open (the inner
					 * `<Show>`). Unmounting on secondary-page open is what
					 * triggers the snapshot for the round-trip case; the
					 * bridge re-mounts on close and restores from the
					 * slot. Mounted at row level (returns null) so it
					 * doesn't participate in the column flex layout —
					 * placing it inside the column changes the dropdown's
					 * z-stacking against the conversation. See
					 * `prompt-draft-bridge.tsx` for the full lifecycle.
					 */}
					<Show when={!getSecondaryPage()}>
						<PromptDraftBridge />
					</Show>
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
							{/*
							 * `zIndex={10}` lifts the prompt wrapper above
							 * the conversation scrollbox so the prompt's
							 * autocomplete dropdown (absolute, zIndex=100
							 * within this wrapper) wins against anything
							 * the conversation paints at the same screen
							 * cells. OpenTUI zIndex only orders SIBLINGS,
							 * so the dropdown's own zIndex doesn't by
							 * itself beat a Conversation that's two
							 * parents away — the wrapper has to outrank
							 * the scrollbox at this level first.
							 */}
							<box paddingTop={1} flexShrink={0} zIndex={10}>
								<Show
									when={pendingApproval()}
									fallback={
										<Show
											when={pendingSuggestion()}
											fallback={
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
											}
										>
											<SuggestCommandPrompt />
										</Show>
									}
								>
									<PermissionPrompt
										header="△ Permission required"
										title={pendingApproval()?.title ?? ""}
										message={pendingApproval()?.message ?? ""}
										approveLabel="Allow"
										rejectLabel="Reject"
										onRespond={respondApproval}
										pending={pendingApproval}
									/>
								</Show>
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
						{/*
						 * `ErrorBoundary` wraps `AgentProvider` specifically to
						 * catch `resolveModelRef`'s first-boot "No provider is
						 * connected" throw. Without it, a fresh install crashes
						 * through `render()` before any UI mounts, so the user
						 * can never reach the Connect dialog. The fallback
						 * recognizes that error by message prefix and surfaces
						 * a Ctrl+P → Connect hint; any other throw renders a
						 * minimal crash line with the stack logged to console
						 * (see `no-provider-fallback.tsx`). The boundary is NOT
						 * a general-purpose error handler — component-level
						 * error recovery should use its own try/catch.
						 */}
						<ErrorBoundary
							fallback={(error, reset) => (
								<NoProviderFallback error={error} reset={reset} />
							)}
						>
							<LayoutProvider>
								<AgentProvider>
									<Layout />
								</AgentProvider>
							</LayoutProvider>
						</ErrorBoundary>
					</CommandProvider>
				</DialogProvider>
			</ToastProvider>
		</ThemeProvider>
	);
}
