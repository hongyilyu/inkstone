/**
 * `AgentProvider` shell — composes the session-state bag, the reducer,
 * the wrapped actions, and the command bridge. All the heavy lifting
 * lives in the submodules under this folder; this file is assembly +
 * side-effect wiring (confirmFn, persistence error handler,
 * subscription dispose).
 *
 * See the inline JSDoc on `AgentStoreState.isStreaming` in
 * `@bridge/view-model` for why that flag is read-only-shared across
 * surfaces and MUST NOT be used as a gating signal for any future
 * permission/approval UI. This provider is the only place `setStore`
 * writes to `isStreaming` today.
 */

import {
	createSession as createAgentSession,
	generateSessionTitle,
	getConfirmFn,
	getSuggestCommandFn,
	type Session,
	type SuggestCommandDecision,
	type SuggestCommandRequest,
	setConfirmFn,
	setSuggestCommandFn,
} from "@backend/agent";
import {
	getPersistenceErrorHandler,
	setPersistenceErrorHandler,
} from "@backend/persistence/errors";
import type { AgentStoreState } from "@bridge/view-model";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	createSignal,
	onCleanup,
	type ParentProps,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useCommand } from "../../components/dialog/command";
import { useDialog } from "../../ui/dialog";
import { useToast } from "../../ui/toast";
import { createWrappedActions } from "./actions";
import { BridgeAgentCommands } from "./commands";
import { createPreviewRegistry } from "./preview-registry";
import { createAgentEventHandler } from "./reducer";
import { createSessionState } from "./session-state";
import {
	type AgentContextValue,
	agentContext,
	type PendingApproval,
	type PendingSuggestion,
	type SessionFactory,
} from "./types";

export function AgentProvider(
	props: ParentProps<{
		session?: SessionFactory;
		sessionTitleGenerator?: typeof generateSessionTitle;
	}>,
) {
	const dialog = useDialog();
	const toast = useToast();
	const command = useCommand();

	// Per-`callId` diff preview registry. See `docs/APPROVAL-UI.md`
	// § State shapes for the three-cell rationale. Ephemeral —
	// cleared on provider unmount + session boundaries in actions.
	const previews = createPreviewRegistry();
	onCleanup(() => {
		previews.clearAll();
	});

	// Pending-approval signal. See `docs/APPROVAL-UI.md` § State
	// shapes. Tripwire: must be a standalone signal, NOT a store
	// field — see the `isStreaming` deadlock note in
	// `@bridge/view-model`'s `AgentStoreState` docstring.
	const [pendingApproval, setPendingApproval] = createSignal<{
		request: PendingApproval;
		resolve: (ok: boolean) => void;
	} | null>(null);

	function respondApproval(ok: boolean): void {
		const entry = pendingApproval();
		if (!entry) return;
		// Clear first so `PermissionPrompt` unmounts before the
		// backend's beforeToolCall returns — otherwise a fast tool
		// chain races the unmount.
		setPendingApproval(null);
		entry.resolve(ok);
	}

	// Pending `suggest_command` signal. Parallel to `pendingApproval`
	// above: the tool's execute() awaits the user's decision via the
	// injected resolver, and the layout replaces the Prompt cell with
	// `SuggestCommandPrompt` while an entry is set. Mirroring the
	// approval pattern (two standalone signals rather than a shared
	// abstraction) per the tripwire in `AgentStoreState.isStreaming`'s
	// docstring — unifying them into a single "pendingPanel" signal
	// would couple the two flows and make the unmount-resolve path
	// harder to reason about.
	const [pendingSuggestion, setPendingSuggestion] = createSignal<{
		request: PendingSuggestion;
		resolve: (decision: SuggestCommandDecision) => void;
	} | null>(null);

	function respondSuggestion(decision: SuggestCommandDecision): void {
		const entry = pendingSuggestion();
		if (!entry) return;
		setPendingSuggestion(null);
		entry.resolve(decision);
		if (decision !== "confirmed") return;
		// Replay the slash through the unified command registry — same
		// path a manually-typed `/article` takes. The eventual
		// `actions.prompt(text)` call hits `agent.signal` truthy (the
		// suggest_command tool is still unwinding its own turn) and
		// takes the `agent.followUp(...)` branch, so pi-agent-core's
		// loop drains the queued user message at the natural end of the
		// current run (see `agent-loop.js:136-141`). No TUI-side signal,
		// effect, or `waitForIdle` needed — this uses pi-agent-core's
		// designed post-run drain primitive.
		const fired = command.triggerSlash(
			entry.request.command,
			entry.request.args,
		);
		if (!fired) {
			// Registry couldn't dispatch (agent-scoped entry not
			// registered, or the command was removed between the
			// suggestion and the confirm). The user clicked Confirm and
			// saw nothing happen — surface the failure via toast so it
			// isn't silent.
			toast.show({
				variant: "error",
				title: "Command replay failed",
				message: `/${entry.request.command} ${entry.request.args}`.trim(),
				duration: 6000,
			});
		}
	}

	// Install backend side-effect handlers. Restore on unmount so a
	// re-mount (tests, future HMR) doesn't null-clear globals.
	const prevConfirmFn = getConfirmFn();
	// Direct ref for the unmount path — reads on the Solid signal
	// during owner disposal are fragile; this sidesteps that.
	let inFlightResolver: ((ok: boolean) => void) | null = null;
	setConfirmFn((req) => {
		if (req.preview?.unifiedDiff) {
			previews.set(req.callId, {
				filepath: req.preview.filepath,
				unifiedDiff: req.preview.unifiedDiff,
			});
		}
		return new Promise<boolean>((resolve) => {
			const wrappedResolve = (ok: boolean) => {
				previews.clear(req.callId);
				inFlightResolver = null;
				resolve(ok);
			};
			inFlightResolver = wrappedResolve;
			setPendingApproval({
				request: {
					callId: req.callId,
					title: req.title,
					message: req.message,
				},
				resolve: wrappedResolve,
			});
		});
	});
	onCleanup(() => {
		setConfirmFn(prevConfirmFn);
		// Unmount → resolve pending to false so the agent loop
		// unwinds. `queueMicrotask` avoids a Bun 1.3.4 segfault in
		// OpenTUI's teardown when the Promise consumer wakes during
		// owner disposal.
		if (inFlightResolver) {
			const resolver = inFlightResolver;
			inFlightResolver = null;
			queueMicrotask(() => resolver(false));
		}
	});

	// Install the suggest_command resolver. Same shape as the confirm
	// handler above: preserve the previous value, wrap the Promise so
	// we can rescue it on unmount. Direct ref (not the Solid signal)
	// because signal reads during owner disposal are fragile.
	const prevSuggestCommandFn = getSuggestCommandFn();
	let inFlightSuggestionResolver:
		| ((decision: SuggestCommandDecision) => void)
		| null = null;
	setSuggestCommandFn(async (req: SuggestCommandRequest) => {
		return new Promise<SuggestCommandDecision>((resolve) => {
			const wrappedResolve = (decision: SuggestCommandDecision) => {
				inFlightSuggestionResolver = null;
				resolve(decision);
			};
			inFlightSuggestionResolver = wrappedResolve;
			setPendingSuggestion({
				request: {
					callId: req.callId,
					command: req.command,
					args: req.args,
					rationale: req.rationale,
				},
				resolve: wrappedResolve,
			});
		});
	});
	onCleanup(() => {
		setSuggestCommandFn(prevSuggestCommandFn);
		if (inFlightSuggestionResolver) {
			const resolver = inFlightSuggestionResolver;
			inFlightSuggestionResolver = null;
			queueMicrotask(() => resolver("cancelled"));
		}
	});

	// Route backend persistence write failures (disk-full, permission-
	// denied, read-only filesystem, DB I/O errors) through the toast
	// surface. Without a handler the backend falls back to
	// `console.error`, so the failure is never silent.
	const prevPersistenceHandler = getPersistenceErrorHandler();
	setPersistenceErrorHandler(({ kind, action, error }) => {
		const msg = error instanceof Error ? error.message : String(error);
		const titleKind =
			kind === "config" ? "Config" : kind === "auth" ? "Auth" : "Session";
		toast.show({
			variant: "error",
			title: `${titleKind} ${action} failed`,
			message: msg,
			duration: 6000,
		});
	});
	onCleanup(() => {
		setPersistenceErrorHandler(prevPersistenceHandler);
	});

	// Build the one session this provider owns. Boot always shows the
	// openpage — no auto-resume. Past session rows stay on disk for a
	// future `/resume` command (not yet built). See D13 in
	// `docs/AGENT-DESIGN.md`: agent is fixed for a session's lifetime.
	//
	// Forward-declared handler + ref-assignment pattern: the session
	// factory takes an `onEvent` callback, but the reducer that
	// implements it needs the `SessionState` bag which depends on the
	// built session. To avoid relying on the factory not synchronously
	// emitting events (pi-agent-core's `Agent` happens not to, but
	// that's a runtime invariant we'd rather not lean on), declare a
	// mutable `handlerRef` first, hand an adapter closure to the
	// factory, then assign the real handler once everything is wired.
	// An early synchronous emission would see the no-op default and
	// drop — still wrong, but explicit rather than TDZ.
	const factory: SessionFactory = props.session ?? createAgentSession;
	const titleGenerator = props.sessionTitleGenerator ?? generateSessionTitle;
	let handlerRef: (event: AgentEvent) => void = () => {};
	const agentSession: Session = factory({
		onEvent: (event: AgentEvent) => handlerRef(event),
	});
	// Tear down the backend subscription on provider unmount. Without
	// this, the pi-agent-core `Agent` keeps a strong ref to the
	// event handler closure, which closes over the (now-disposed)
	// Solid store — leaks listeners and pins the disposed owner tree
	// against GC. Safe to call `dispose?.` for older fake factories
	// that don't implement the method.
	onCleanup(() => {
		agentSession.dispose?.();
	});

	const initialModel = agentSession.getModel();

	const [store, setStore] = createStore<AgentStoreState>({
		messages: [],
		isStreaming: false,
		sidebarSections: [],
		sessionTitle: "inkstone",
		modelName: initialModel.name,
		modelProvider: initialModel.provider,
		contextWindow: initialModel.contextWindow,
		modelReasoning: initialModel.reasoning,
		thinkingLevel: agentSession.getThinkingLevel(),
		status: "idle",
		totalTokens: 0,
		totalCost: 0,
		lastTurnStartedAt: 0,
		currentAgent: agentSession.agentName,
	});

	const sessionState = createSessionState({ agentSession, store, setStore });

	handlerRef = createAgentEventHandler({
		store,
		setStore,
		sessionState,
		agentSession,
	});

	const wrappedActions = createWrappedActions({
		agentSession,
		store,
		setStore,
		sessionState,
		toast,
		titleGenerator,
		previews,
		pendingApproval: () => pendingApproval()?.request ?? null,
		respondApproval,
		pendingSuggestion: () => pendingSuggestion()?.request ?? null,
		respondSuggestion,
	});

	const value: AgentContextValue = {
		store,
		actions: wrappedActions,
		session: {
			getModel: () => agentSession.getModel(),
			getProviderId: () => agentSession.getProviderId(),
			getModelId: () => agentSession.getModelId(),
			getThinkingLevel: () => agentSession.getThinkingLevel(),
			getCurrentSessionId: () => sessionState.getCurrentSessionId(),
		},
		previews,
		pendingApproval: () => pendingApproval()?.request ?? null,
		respondApproval,
		pendingSuggestion: () => pendingSuggestion()?.request ?? null,
		respondSuggestion,
	};

	return (
		<agentContext.Provider value={value}>
			<BridgeAgentCommands
				deps={{
					actions: wrappedActions,
					store,
					setStore,
					sessionState,
					dialog,
					toast,
				}}
			/>
			{props.children}
		</agentContext.Provider>
	);
}

export function useAgent() {
	const value = useContext(agentContext);
	if (!value) throw new Error("useAgent must be used within an AgentProvider");
	return value;
}
