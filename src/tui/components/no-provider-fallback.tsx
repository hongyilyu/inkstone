/**
 * Fallback rendered by the `ErrorBoundary` around `<AgentProvider>`
 * (see `app.tsx`). The boundary exists specifically to catch
 * `resolveInitialProviderModel`'s "No provider is connected" throw on
 * first boot — without it, a fresh install crashes before the TUI ever
 * mounts, so the user can never reach the Connect dialog.
 *
 * Two branches keyed on the error message:
 *
 *   1. No-provider path (`message.startsWith("No provider is connected")`):
 *      Render a welcome banner + "press Ctrl+P" hint and register a
 *      temporary "Connect" palette entry so the hint actually works.
 *
 *   2. Any other error: log to `console.error` (preserves the stack for
 *      dev) and render a single-line crash message. No retry affordance
 *      — an unknown error usually indicates a real bug, and auto-retry
 *      would just loop.
 *
 * The Connect entry registered here intentionally duplicates the one in
 * `commands/layout-commands.ts:124-137`. That file's registration runs
 * inside `AgentProvider` (it uses `useAgent()`), so it isn't reachable
 * from here. The duplication is scoped to this single screen and auto-
 * disposes on unmount — on successful connect, `props.reset()` unmounts
 * the fallback, the registration's `onCleanup` fires, and the real
 * palette entry takes over when `AgentProvider` re-mounts. Solid's
 * `ErrorBoundary.reset` disposes the old fallback's owner *before*
 * rendering the children again, so even in the pathological case
 * where children re-throw (same error, same branch), the old
 * registration is removed before the new fallback mounts — the
 * palette never ends up with stacked duplicate entries.
 */

import { saveConfig } from "@backend/persistence/config";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo, Show } from "solid-js";
import { useTheme } from "../context/theme";
import { useCommand } from "./dialog/command";
// Aliased to avoid a name collision with `../ui/dialog`'s `DialogProvider`
// (the dialog-stack context). This file only needs the provider-picker.
import { DialogProvider as DialogProviderSelect } from "./dialog/provider";

// String-prefix check instead of a typed-error subclass. The prefix is
// stable (it's the "signed-in" marker for this specific failure mode);
// an unrelated error with the same prefix would be a coincidence, and
// the only caller who throws this message is `resolveInitialProviderModel`
// in `src/backend/agent/index.ts`.
const NO_PROVIDER_PREFIX = "No provider is connected";

export function NoProviderFallback(props: {
	error: unknown;
	reset: () => void;
}) {
	const message = createMemo(() =>
		props.error instanceof Error ? props.error.message : String(props.error),
	);
	const isNoProvider = createMemo(() =>
		message().startsWith(NO_PROVIDER_PREFIX),
	);

	return (
		<Show
			when={isNoProvider()}
			fallback={<FatalError message={message()} error={props.error} />}
		>
			<ConnectPrompt reset={props.reset} />
		</Show>
	);
}

/**
 * No-provider branch. Renders the welcome + hint and registers a
 * temporary "Connect" palette entry. On successful model pick, persists
 * the selection to config and calls the boundary's `reset()` so
 * `AgentProvider` re-mounts with a valid provider.
 */
function ConnectPrompt(props: { reset: () => void }) {
	const { theme } = useTheme();
	const command = useCommand();

	const onModelSelected = (model: Model<Api>) => {
		// Persist the user's pick first — the next mount's `loadConfig()`
		// must see providerId/modelId for `resolveInitialProviderModel` to
		// succeed. `saveConfig` handles its own I/O errors via the
		// persistence error handler (falls back to `console.error` here
		// since `AgentProvider`'s toast wiring isn't mounted yet).
		saveConfig({ providerId: model.provider, modelId: model.id });
		props.reset();
	};

	// Single palette entry, registered for the fallback's lifetime. The
	// `register` helper auto-disposes on unmount (via `onCleanup` in
	// `command.tsx:223`), so after `reset()` unmounts this component the
	// entry is gone and `layout-commands.ts`'s registration owns the name.
	command.register(() => [
		{
			id: "connect",
			title: "Connect",
			description: "Sign in to a provider",
			onSelect: (d) => {
				DialogProviderSelect.show(d, onModelSelected, undefined);
			},
		},
	]);

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			alignItems="center"
			justifyContent="center"
			backgroundColor={theme.background}
		>
			<box
				flexDirection="column"
				alignItems="center"
				paddingLeft={2}
				paddingRight={2}
			>
				<text fg={theme.primary}>Welcome to Inkstone</text>
				<box height={1} />
				<text fg={theme.text}>No provider is connected.</text>
				<box height={1} />
				<text fg={theme.textMuted}>
					Press Ctrl+P and choose "Connect" to sign in to Kiro, ChatGPT, or
					OpenRouter.
				</text>
			</box>
		</box>
	);
}

/**
 * Fatal-error branch. Not the reported bug's path — this catches any
 * other synchronous throw from `AgentProvider` (corrupted config,
 * persistence layer failure, etc.). We log the raw error so dev still
 * gets a stack trace in the console, then surface a minimal message.
 * No retry: auto-retrying an unknown error tends to loop.
 */
function FatalError(props: { message: string; error: unknown }) {
	// Preserve dev-time stack: the `ErrorBoundary` otherwise swallows
	// unexpected errors, so a console log is the only trace left.
	console.error("[inkstone] fatal error in AgentProvider:", props.error);
	const { theme } = useTheme();
	return (
		<box
			flexDirection="column"
			flexGrow={1}
			alignItems="center"
			justifyContent="center"
			backgroundColor={theme.background}
		>
			<text fg={theme.error}>Fatal error: {props.message}</text>
		</box>
	);
}
