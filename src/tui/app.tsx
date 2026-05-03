import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, ErrorBoundary, Show } from "solid-js";
import { registerLayoutCommands } from "./commands/layout-commands";
import { Conversation } from "./components/conversation";
import { CommandProvider } from "./components/dialog/command";
import { NoProviderFallback } from "./components/no-provider-fallback";
import { OpenPage } from "./components/open-page";
import { Prompt } from "./components/prompt";
import { SecondaryPage } from "./components/secondary-page";
import { SessionList } from "./components/session-list";
import { Sidebar } from "./components/sidebar";
import { AgentProvider, useAgent } from "./context/agent";
import { getSecondaryPage } from "./context/secondary-page";
import { ThemeProvider, useTheme } from "./context/theme";
import { useLayoutKeybinds } from "./hooks/use-layout-keybinds";
import { DialogProvider } from "./ui/dialog";
import { Toast, ToastProvider } from "./ui/toast";

// Module-scoped refs for the scroll container and prompt input. Both
// are set via `ref=` callbacks from Layout's JSX; the ref callbacks
// register `onCleanup` to null these back out on unmount so a stale
// ref can't survive the owner that created it (e.g. a re-mounted
// Layout's `toBottom()` would otherwise dispatch to a destroyed
// renderable). `scrollRef` / `inputRef` accessors expose the current
// value to the layout-level keybind hook.
let scroll: ScrollBoxRenderable | null = null;
let inputRef: any = null;

export function scrollRef(): ScrollBoxRenderable | null {
	return scroll;
}

export function setScrollRef(ref: ScrollBoxRenderable) {
	scroll = ref;
}

/**
 * Null the module-scoped scroll ref if `ref` matches. Called from the
 * ref callback's `onCleanup` in `conversation.tsx` so unmounting the
 * scrollbox doesn't leave a dangling handle module-wide. Identity
 * check prevents a late cleanup from a previous mount from clobbering
 * a new mount's ref.
 */
export function clearScrollRef(ref: ScrollBoxRenderable) {
	if (scroll === ref) scroll = null;
}

export function setInputRef(ref: any) {
	inputRef = ref;
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
	setTimeout(() => {
		if (!scroll || scroll.isDestroyed) return;
		scroll.scrollTo(scroll.scrollHeight);
	}, 50);
}

export function Layout() {
	const { actions, store } = useAgent();
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
								<Layout />
							</AgentProvider>
						</ErrorBoundary>
					</CommandProvider>
				</DialogProvider>
			</ToastProvider>
		</ThemeProvider>
	);
}
