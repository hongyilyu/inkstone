import type { RunEventValue } from "@inkstone/ui-sdk";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * A tool call surfaced live within an assistant turn (ADR-0006 tool_call Run
 * Event). `id` is the wire `tool_call_id`; `status` is the UI lifecycle
 * (`running` while Core dispatches it, then a terminal `completed`/`error`).
 * The wire `started` status maps to `running` (see {@link applyEvent}).
 */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "error";
}

/**
 * The canonical live UI message (distinct from the demoted `MockChatMessage`).
 * Mirrors the wire `MessageView` shape so slice-13 hydration maps cleanly.
 */
export interface Message {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly status: "streaming" | "completed" | "incomplete";
	readonly text: string;
	readonly run_id: string;
	/**
	 * Tool calls observed during this assistant turn, in arrival order. Driven
	 * by `tool_call` Run Events (ADR-0006); ephemeral, so a Run rehydrated from
	 * history starts without them (ADR-0022 defers durable replay).
	 */
	readonly toolCalls?: readonly ToolCall[];
	/**
	 * Set when a Run terminates with an `error` Run Event (ADR-0006): the
	 * worker/provider failure message. Drives the error rendering in the
	 * assistant bubble so a failed Run is never a silent blank.
	 */
	readonly error?: string;
}

/**
 * Per-thread state. `activeRunId` is the in-flight run, if any. `snapshotApplied`
 * tracks, per run, whether the first `text_delta` (the cumulative snapshot) has
 * been applied — that drives the SET-vs-APPEND rule in {@link applyEvent}.
 */
interface ThreadState {
	readonly messages: Message[];
	readonly activeRunId?: string;
	readonly snapshotApplied?: Record<string, boolean>;
}

interface ChatState {
	readonly threads: Record<string, ThreadState>;
	readonly focusedThreadId?: string;
	/**
	 * Pending (and decided) Proposals keyed by the parked Run's id (ADR-0025).
	 * A `propose_workspace_mutation` parks a Run; the chat surface renders the
	 * review card under that Run's assistant turn (which carries the same
	 * `run_id`). The UI `status` is the review lifecycle, distinct from the wire
	 * Proposal status: `deciding` and `error` are local-only (no wire equivalent).
	 */
	readonly proposals: Record<string, PendingProposal>;
}

/**
 * A Proposal surfaced for review under its parked Run's assistant turn. Mirrors
 * `ProposalGetResult` (ADR-0025) plus a UI `status` driving the card's states:
 * `pending` (actions live) · `deciding` (decide in flight) · `accepted` /
 * `rejected` (decided) · `error` (decide failed — offer retry).
 */
export interface PendingProposal {
	readonly proposal_id: string;
	readonly run_id: string;
	readonly mutation_kind: string;
	readonly payload: unknown;
	readonly rationale: string | null;
	readonly status: "pending" | "deciding" | "accepted" | "rejected" | "error";
}

// ---------------------------------------------------------------------------
// Zustand store (slice A migration). The store is a plain *vanilla* store so the
// free action functions below stay callable OUTSIDE React render — the bridge
// (`bridge.ts`) and hydration (`hydrate.ts`) drive these imperatively. The
// selector hooks wrap zustand's `useStore`, which is backed by
// `useSyncExternalStore`; returning stable references (e.g. `EMPTY_MESSAGES`)
// preserves selector identity across unrelated state changes. ADR-0020: Effect
// owns the wire; React state is plain (zustand, not `@effect/atom`).
// ---------------------------------------------------------------------------

const initialState = (): ChatState => ({ threads: {}, proposals: {} });

const store = createStore<ChatState>()(() => initialState());

/** Read the raw state (test + bridge use this; components use the hooks). */
export function getChatState(): ChatState {
	return store.getState();
}

/** Reset to empty state — for test isolation. Replace mode so stale threads
 * (and any `focusedThreadId`) don't leak between tests. */
export function resetChatStore(): void {
	store.setState(initialState(), true);
}

let idCounter = 0;
/** Monotonic local message id. Live messages are client-minted, not wire ids. */
export function nextMessageId(): string {
	idCounter += 1;
	return `m${idCounter}`;
}

// --- internal immutable helper ---------------------------------------------

function withThread(
	s: ChatState,
	threadId: string,
	fn: (t: ThreadState) => ThreadState,
): ChatState {
	const existing = s.threads[threadId] ?? { messages: [] };
	return {
		...s,
		threads: { ...s.threads, [threadId]: fn(existing) },
	};
}

// --- actions ----------------------------------------------------------------

export function setFocusedThread(threadId: string): void {
	store.setState((s) => ({ ...s, focusedThreadId: threadId }));
}

/** Clear the focused thread (New Chat → null → next send mints a thread). */
export function clearFocusedThread(): void {
	store.setState((s) => ({ ...s, focusedThreadId: undefined }));
}

// --- proposals (ADR-0025) ---------------------------------------------------

/**
 * Attach (or replace) the pending Proposal for `runId`, keyed by the parked
 * Run's id. Driven by a `proposal/pending` notification → `proposal/get`
 * round-trip in the bridge. Always lands as `pending` — the review starts with
 * its actions live.
 */
export function setPendingProposal(proposal: PendingProposal): void {
	store.setState((s) => ({
		...s,
		proposals: { ...s.proposals, [proposal.run_id]: proposal },
	}));
}

/**
 * Move a Proposal to a new review `status` (deciding/accepted/rejected/error).
 * A no-op if no Proposal is attached for `runId` (a `proposal/changed` can race
 * ahead of the `proposal/get` that seeds the card).
 */
export function setProposalStatus(
	runId: string,
	status: PendingProposal["status"],
): void {
	store.setState((s) => {
		const existing = s.proposals[runId];
		if (existing === undefined) {
			return s;
		}
		return {
			...s,
			proposals: { ...s.proposals, [runId]: { ...existing, status } },
		};
	});
}

/**
 * Clear the snapshot-applied bit for `runId` (ADR-0025 resume re-subscribe).
 * A parked Run's resume opens a FRESH `run/subscribe` whose first `text_delta`
 * is again the cumulative snapshot (`subscribe.rs` always emits one). The
 * original parked subscribe already marked `snapshotApplied[runId] = true`, so
 * without this reset the resume snapshot would be treated as an incremental
 * delta and APPENDed — duplicating any pre-park assistant text. Resetting the
 * bit makes the next `text_delta` SET the authoritative cumulative text (which
 * already contains the pre-park prefix). A no-op when the thread is unknown.
 */
export function resetSnapshot(threadId: string, runId: string): void {
	store.setState((s) => {
		const thread = s.threads[threadId];
		if (thread === undefined || thread.snapshotApplied?.[runId] === undefined) {
			return s;
		}
		const { [runId]: _dropped, ...rest } = thread.snapshotApplied;
		return withThread(s, threadId, (t) => ({ ...t, snapshotApplied: rest }));
	});
}

export function appendUserMessage(threadId: string, message: Message): void {
	store.setState((s) =>
		withThread(s, threadId, (t) => ({
			...t,
			messages: [...t.messages, message],
		})),
	);
}

/**
 * Append a live (streaming) assistant message. The bridge seeds this BEFORE the
 * run id is known (run_id `""`), then {@link attachRun} promotes it once
 * `postMessage` resolves. Keeping the bubble around lets the failed-send path
 * flip it to `incomplete` (Q7).
 */
export function seedAssistantMessage(threadId: string, message: Message): void {
	store.setState((s) =>
		withThread(s, threadId, (t) => ({
			...t,
			messages: [...t.messages, message],
		})),
	);
}

/** Promote a seeded assistant message: bind its run id and mark the run active. */
export function attachRun(
	threadId: string,
	messageId: string,
	runId: string,
): void {
	store.setState((s) => {
		const thread = s.threads[threadId];
		if (thread === undefined) {
			return s;
		}
		const messages = thread.messages.map(
			(m): Message => (m.id === messageId ? { ...m, run_id: runId } : m),
		);
		return withThread(s, threadId, (t) => ({
			...t,
			messages,
			activeRunId: runId,
		}));
	});
}

/**
 * Load a thread's hydrated history (slice 13). Replaces the thread's messages
 * with the wire→live mapped set and points `activeRunId` at the streaming
 * message's run, if any (else clears it).
 *
 * CRITICAL (snapshot-vs-resubscribe interplay): this does NOT pre-mark
 * `snapshotApplied[run_id]` for the streaming message. Leaving it unset means
 * the resubscribe's FIRST `text_delta` (the cumulative snapshot) SETs the text
 * to the authoritative cumulative value in {@link applyEvent} — the hydrated
 * partial text is just an initial paint that the snapshot then supersedes. The
 * orchestrator (`hydrate.ts#hydrateThread`) owns the thread/get → load →
 * resubscribe flow; this action only loads.
 */
export function loadThreadMessages(
	threadId: string,
	messages: Message[],
): void {
	const streaming = messages.find((m) => m.status === "streaming");
	store.setState((s) =>
		withThread(s, threadId, (t) => ({
			...t,
			messages,
			activeRunId: streaming?.run_id,
		})),
	);
}

/**
 * Non-destructively prepend fetched history to a thread that became live during
 * an in-flight `thread/get` (a send seeded an optimistic turn under the loading
 * skeleton). The fetched messages are the OLDER turns; the local messages are
 * the live turn — so history goes in front, and any run already present locally
 * is skipped so the seeded turn (and its in-flight stream) is never duplicated
 * or clobbered. Leaves `activeRunId` untouched: the live turn keeps owning it.
 */
export function prependHistory(threadId: string, history: Message[]): void {
	store.setState((s) => {
		const thread = s.threads[threadId];
		if (thread === undefined) {
			return s;
		}
		const localRuns = new Set(
			thread.messages.map((m) => m.run_id).filter((id) => id !== ""),
		);
		const older = history.filter(
			(m) => m.run_id === "" || !localRuns.has(m.run_id),
		);
		if (older.length === 0) {
			return s;
		}
		return withThread(s, threadId, (t) => ({
			...t,
			messages: [...older, ...t.messages],
		}));
	});
}

/** Mark a seeded assistant message failed by id (failed-send path, Q7). */
export function markMessageIncomplete(
	threadId: string,
	messageId: string,
): void {
	store.setState((s) => {
		const thread = s.threads[threadId];
		if (thread === undefined) {
			return s;
		}
		const messages = thread.messages.map(
			(m): Message => (m.id === messageId ? { ...m, status: "incomplete" } : m),
		);
		return withThread(s, threadId, (t) => ({ ...t, messages }));
	});
}

/**
 * Settle any tool call still marked `running` when its Run terminates. The
 * terminal `tool_call` boundary is ephemeral, so it can be lost to broadcast
 * lag (ADR-0022 does not replay it) or never arrive if Core ends mid-dispatch;
 * without this the indicator would animate forever on a finished turn. Returns
 * the same reference when nothing is running, preserving selector identity.
 */
function settleRunningToolCalls(
	toolCalls: readonly ToolCall[] | undefined,
	terminal: "completed" | "error",
): readonly ToolCall[] | undefined {
	if (
		toolCalls === undefined ||
		!toolCalls.some((tc) => tc.status === "running")
	) {
		return toolCalls;
	}
	return toolCalls.map((tc) =>
		tc.status === "running" ? { ...tc, status: terminal } : tc,
	);
}

/**
 * Apply a streamed run event to the thread's assistant message for `runId`.
 *
 * SET-vs-APPEND rule (slice 2/8): the FIRST `text_delta` after subscribe is the
 * cumulative snapshot → SET the text; subsequent deltas → APPEND. On `done`:
 * finalize (status `completed`) and clear `activeRunId` for that run.
 */
export function applyEvent(
	threadId: string,
	runId: string,
	event: RunEventValue,
): void {
	store.setState((s) => {
		const thread = s.threads[threadId];
		if (thread === undefined) {
			return s;
		}

		if (event.kind === "text_delta") {
			const applied = thread.snapshotApplied?.[runId] ?? false;
			const messages = thread.messages.map(
				(m): Message =>
					m.role === "assistant" && m.run_id === runId
						? { ...m, text: applied ? m.text + event.delta : event.delta }
						: m,
			);
			return withThread(s, threadId, (t) => ({
				...t,
				messages,
				snapshotApplied: { ...t.snapshotApplied, [runId]: true },
			}));
		}

		if (event.kind === "tool_call") {
			// Upsert the tool call on the assistant message for this run: a
			// `started` event appends a `running` row; a terminal event flips the
			// matching row to `completed`/`error`. The wire `started` maps to the
			// UI `running` vocabulary.
			const status = event.status === "started" ? "running" : event.status;
			const messages = thread.messages.map((m): Message => {
				if (m.role !== "assistant" || m.run_id !== runId) {
					return m;
				}
				const existing = m.toolCalls ?? [];
				const found = existing.some((tc) => tc.id === event.tool_call_id);
				const toolCalls: ToolCall[] = found
					? existing.map((tc) =>
							tc.id === event.tool_call_id ? { ...tc, status } : tc,
						)
					: [...existing, { id: event.tool_call_id, name: event.name, status }];
				return { ...m, toolCalls };
			});
			return withThread(s, threadId, (t) => ({ ...t, messages }));
		}

		if (event.kind === "error") {
			// A worker-emitted error (ADR-0006) is terminal: flip the
			// assistant message to `incomplete`, attach the error message so
			// the bubble can surface it (a failed Run must never be a silent
			// blank), and clear the active run.
			const messages = thread.messages.map(
				(m): Message =>
					m.role === "assistant" && m.run_id === runId
						? {
								...m,
								status: "incomplete",
								error: event.message,
								toolCalls: settleRunningToolCalls(m.toolCalls, "error"),
							}
						: m,
			);
			return withThread(s, threadId, (t) => ({
				...t,
				messages,
				activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
			}));
		}

		if (event.kind === "cancelled") {
			// User cancellation (ADR-0014) is terminal but NOT a failure: flip the
			// assistant message to `incomplete` so its partial text renders as an
			// unfinished cancelled response (never deleted, never a clean answer),
			// settle any running tool calls, and clear the active run. No `error`
			// is attached — cancellation is user-ended, not a worker fault. Core
			// mirrors this server-side (mark_streaming_messages_incomplete).
			const messages = thread.messages.map(
				(m): Message =>
					m.role === "assistant" && m.run_id === runId
						? {
								...m,
								status: "incomplete",
								toolCalls: settleRunningToolCalls(m.toolCalls, "completed"),
							}
						: m,
			);
			return withThread(s, threadId, (t) => ({
				...t,
				messages,
				activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
			}));
		}

		// done → finalize the assistant message and clear the active run.
		const messages = thread.messages.map(
			(m): Message =>
				m.role === "assistant" && m.run_id === runId
					? {
							...m,
							status: "completed",
							toolCalls: settleRunningToolCalls(m.toolCalls, "completed"),
						}
					: m,
		);
		return withThread(s, threadId, (t) => ({
			...t,
			messages,
			activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
		}));
	});
}

// --- selector hooks (slice 12 consumes these) ------------------------------

const EMPTY_MESSAGES: Message[] = [];

/** Live messages for a thread (stable reference between unchanged renders). */
export function useThreadMessages(threadId: string): Message[] {
	return useStore(
		store,
		(s) => s.threads[threadId]?.messages ?? EMPTY_MESSAGES,
	);
}

/** Focused thread id, `null` at the React boundary (undefined internally). */
export function useFocusedThreadId(): string | null {
	return useStore(store, (s) => s.focusedThreadId ?? null);
}

/** Active run id for a thread, `null` at the React boundary. */
export function useActiveRunId(threadId: string): string | null {
	return useStore(store, (s) => s.threads[threadId]?.activeRunId ?? null);
}

/** The pending/decided Proposal attached to `runId`, `null` if none. */
export function useProposalForRun(runId: string): PendingProposal | null {
	return useStore(store, (s) => s.proposals[runId] ?? null);
}
