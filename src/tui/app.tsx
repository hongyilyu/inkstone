import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, ErrorBoundary, Show } from "solid-js";
import { registerLayoutCommands } from "./commands/layout-commands";
import { Conversation } from "./components/conversation";
import { CommandProvider } from "./components/dialog/command";
import { NoProviderFallback } from "./components/no-provider-fallback";
import { OpenPage } from "./components/open-page";
import { PermissionPrompt } from "./components/permission-prompt";
import { Prompt } from "./components/prompt";
import { SecondaryPage } from "./components/secondary-page";
import { SessionList } from "./components/session-list";
import { Sidebar } from "./components/sidebar";
import { SuggestCommandPrompt } from "./components/suggest-command-prompt";
import { AgentProvider, useAgent } from "./context/agent";
import { getActiveLayout, LayoutProvider } from "./context/layout";
import { getSecondaryPage } from "./context/secondary-page";
import { ThemeProvider, useTheme } from "./context/theme";
import { useLayoutKeybinds } from "./hooks/use-layout-keybinds";
import { DialogProvider } from "./ui/dialog";
import { Toast, ToastProvider } from "./ui/toast";

// Module-scoped ref for the prompt input. Set via `ref=` callback
// from Layout's JSX; the ref callback registers `onCleanup` to null
// this back out on unmount. Stack C is migrating scroll out to
// `LayoutContext` first; input refs follow in C2. Until C2 lands,
// the shim accessors below proxy scroll through `getActiveLayout()`
// while input ones still read the module-local `inputRef`.
let inputRef: any = null;

export function scrollRef(): ScrollBoxRenderable | null {
	return getActiveLayout()?.getScroll() ?? null;
}

export function setScrollRef(ref: ScrollBoxRenderable) {
	getActiveLayout()?.setScrollRef(ref);
}

/**
 * Null the registered scroll ref if `ref` matches. Shim during the
 * Stack-C migration window — see `scrollRef` above.
 */
export function clearScrollRef(ref: ScrollBoxRenderable) {
	getActiveLayout()?.clearScrollRef(ref);
}

export function setInputRef(ref: any) {
	inputRef = ref;
}

/**
 * Read the current prompt textarea ref. Mirrors `scrollRef()` — used
 * by surfaces that write into the prompt imperatively (e.g. the
 * suggest-command panel's Edit action pre-populating the slash).
 */
export function getInputRef(): any {
	return inputRef;
}

/**
 * Null the module-scoped input ref if `ref` matches. Mirror of
 * `clearScrollRef` — called from the prompt textarea's ref cleanup.
 */
export function clearInputRef(ref: any) {
	if (inputRef === ref) inputRef = null;
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
	getActiveLayout()?.scrollToBottom();
}

/**
 * Bridge for the prompt's two-stage Ctrl+C behavior. The single
 * `useKeyboard` registration for `app_exit` lives in
 * `useLayoutKeybinds` (a parent of `<Prompt>`); since EventEmitter
 * dispatches global listeners in registration order and the parent's
 * onMount fires first, only one handler can own Ctrl+C. The Prompt
 * component publishes its decision callbacks here on mount and nulls
 * them on unmount; the layout handler consults `getPromptCtrlCBridge`
 * to decide between clear/arm/exit. When the prompt isn't mounted
 * (boot fallback, approval / suggestion panels) the bridge is null
 * and the layout handler falls back to immediate exit.
 */
export interface PromptCtrlCBridge {
	decide: () => "clear" | "arm" | "fall_through";
	clear: () => void;
	arm: () => void;
	disarm: () => void;
}

let promptCtrlCBridge: PromptCtrlCBridge | null = null;

export function setPromptCtrlCBridge(bridge: PromptCtrlCBridge | null) {
	promptCtrlCBridge = bridge;
}

export function getPromptCtrlCBridge(): PromptCtrlCBridge | null {
	return promptCtrlCBridge;
}

export function Layout() {
	const { actions, store, pendingApproval, pendingSuggestion } = useAgent();
	const { theme } = useTheme();
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
		refocusInput();
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
										<Show when={pendingSuggestion()} fallback={<Prompt />}>
											<SuggestCommandPrompt />
										</Show>
									}
								>
									<PermissionPrompt />
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
						 * catch `resolveInitialProviderModel`'s first-boot
						 * "No provider is connected" throw. Without it, a fresh
						 * install crashes through `render()` before any UI mounts,
						 * so the user can never reach the Connect dialog. The
						 * fallback recognizes that error by message prefix and
						 * surfaces a Ctrl+P → Connect hint; any other throw
						 * renders a minimal crash line with the stack logged to
						 * console (see `no-provider-fallback.tsx`). The boundary
						 * is NOT a general-purpose error handler — component-
						 * level error recovery should use its own try/catch.
						 */}
						<ErrorBoundary
							fallback={(error, reset) => (
								<NoProviderFallback error={error} reset={reset} />
							)}
						>
							<AgentProvider>
								<LayoutProvider>
									<Layout />
								</LayoutProvider>
							</AgentProvider>
						</ErrorBoundary>
					</CommandProvider>
				</DialogProvider>
			</ToastProvider>
		</ThemeProvider>
	);
}
