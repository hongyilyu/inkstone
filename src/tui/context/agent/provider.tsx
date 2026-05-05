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
import {
	createSignal,
	onCleanup,
	type ParentProps,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
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

	// Per-`callId` diff preview registry. Populated from the confirmFn
	// closure below when an approval request carries a `preview`;
	// consumed by `ToolPart` to render the diff inline. Ephemeral —
	// cleared on provider unmount.
	const previews = createPreviewRegistry();
	onCleanup(() => {
		previews.clearAll();
	});

	// Phase-5: scoped pending-approval signal. When set, the layout
	// swaps the `Prompt` cell for `PermissionPrompt` and the panel's
	// local `useKeyboard` owns Approve/Reject. We store the resolver
	// alongside the display payload so `respondApproval(ok)` can
	// resolve the in-flight Promise returned by `confirmFn`. A
	// standalone `createSignal` (not a store field) honors the
	// view-model tripwire: don't gate approval UI on `isStreaming`;
	// use a per-action pending signal.
	const [pendingApproval, setPendingApproval] = createSignal<{
		request: PendingApproval;
		resolve: (ok: boolean) => void;
	} | null>(null);

	function respondApproval(ok: boolean): void {
		const entry = pendingApproval();
		if (!entry) return;
		// Clear FIRST so the layout unmounts `PermissionPrompt` and
		// re-mounts `Prompt` before the backend's beforeToolCall hook
		// returns and any follow-up turn starts emitting events —
		// otherwise a fast tool chain would race the unmount.
		setPendingApproval(null);
		entry.resolve(ok);
	}

	// Install backend side-effect handlers, capturing the prior
	// values so a provider re-mount (tests, future HMR) can restore
	// the previous installation rather than null-clearing the
	// globals. Mirrors the symmetry pattern already used by
	// `dialog.setSuspendHandler` in `command.tsx`.
	const prevConfirmFn = getConfirmFn();
	// Hold a direct ref to the in-flight resolver so the unmount path
	// can unwind it without re-reading the Solid signal inside an
	// `onCleanup` (the signal's tracked context is gone by then and
	// reads would return whatever it was last cached as, which is
	// correct here but feels fragile). Direct-ref is simpler and
	// identical in behavior.
	let inFlightResolver: ((ok: boolean) => void) | null = null;
	setConfirmFn((req) => {
		// Phase-4 preview wiring: attach the precomputed unified diff
		// (if any) to the preview registry keyed by the tool-call id,
		// so `ToolPart` can render it above the panel as soon as the
		// matching `toolcall_end` event lands in the reducer. Clear
		// on resolve regardless of approve/reject — the real
		// `tool_execution_end` will promote the part to
		// completed/error via the existing reducer path, and a stale
		// diff would misrepresent the completed tool call.
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
		// Unmount while an approval is pending → resolve to `false`
		// so the agent loop's `await confirmFn(...)` unwinds instead
		// of hanging. Defer via microtask: `onCleanup` runs inside
		// the Solid owner-tree disposal, and synchronously waking a
		// Promise resolver here can race render-tree teardown in
		// OpenTUI's renderer (observed Bun segfault on macOS when
		// the Promise consumer re-reads DOM refs). Queue-Microtask
		// yields to the next tick so the resolver fires AFTER
		// cleanup completes.
		if (inFlightResolver) {
			const resolver = inFlightResolver;
			inFlightResolver = null;
			queueMicrotask(() => resolver(false));
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
