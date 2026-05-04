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
	type Session,
	setConfirmFn,
} from "@backend/agent";
import {
	getPersistenceErrorHandler,
	setPersistenceErrorHandler,
} from "@backend/persistence/errors";
import type { AgentStoreState } from "@bridge/view-model";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { onCleanup, type ParentProps, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import { useDialog } from "../../ui/dialog";
import { DialogConfirm } from "../../ui/dialog-confirm";
import { useToast } from "../../ui/toast";
import { createWrappedActions } from "./actions";
import { BridgeAgentCommands } from "./commands";
import { createAgentEventHandler } from "./reducer";
import { createSessionState } from "./session-state";
import {
	type AgentContextValue,
	agentContext,
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

	// Install backend side-effect handlers, capturing the prior
	// values so a provider re-mount (tests, future HMR) can restore
	// the previous installation rather than null-clearing the
	// globals. Mirrors the symmetry pattern already used by
	// `dialog.setSuspendHandler` in `command.tsx`.
	const prevConfirmFn = getConfirmFn();
	setConfirmFn(async (req) => {
		// Phase 3: structured ConfirmRequest carries callId + optional
		// preview (filepath/oldText/newText/unifiedDiff). Phase 3 is a
		// pure data-plumbing change — the UI still routes through
		// DialogConfirm with just title + message. Phase 4 attaches a
		// synthetic pending tool part carrying the diff; phase 5
		// swaps DialogConfirm for a bottom panel. Extracting title +
		// message here keeps today's modal visually unchanged.
		const result = await DialogConfirm.show(dialog, req.title, req.message);
		return result === true;
	});
	onCleanup(() => {
		setConfirmFn(prevConfirmFn);
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
