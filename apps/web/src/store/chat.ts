import type { ProposalReviewContext } from "@inkstone/protocol";
import type { RunEventValue } from "@inkstone/ui-sdk";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** A tool call surfaced live within an assistant turn (ADR-0006 tool_call Run Event). */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "error";
}

/** The canonical live UI message; mirrors the wire `MessageView` shape. */
export interface Message {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly status: "streaming" | "completed" | "incomplete";
	readonly text: string;
	readonly run_id: string;
	/** Tool calls observed during this assistant turn, in arrival order (ephemeral; ADR-0006). */
	readonly toolCalls?: readonly ToolCall[];
	/** Worker/provider failure message when a Run terminates with an `error` event (ADR-0006). */
	readonly error?: string;
}

/** Reactive hydrate-on-focus lifecycle (replaces the old non-reactive Set): `loading` while `thread/get` is in flight, `error` on a failed fetch (drives a recoverable affordance), `ready` once history is live or locally-originated. Absent = never hydrated. */
export type HydrationStatus = "loading" | "ready" | "error";

/** Per-thread state; `snapshotApplied` drives the SET-vs-APPEND rule in {@link applyEvent}. */
interface ThreadState {
	readonly messages: Message[];
	readonly activeRunId?: string;
	readonly snapshotApplied?: Record<string, boolean>;
	readonly hydration?: HydrationStatus;
}

interface ChatState {
	readonly threads: Record<string, ThreadState>;
	readonly focusedThreadId?: string;
	/** Pending (and decided) Proposals keyed by the parked Run's id (ADR-0025). */
	readonly proposals: Record<string, PendingProposal>;
}

/** A Proposal surfaced for review under its parked Run's assistant turn (ADR-0025). */
export interface PendingProposal {
	readonly proposal_id: string;
	readonly run_id: string;
	readonly mutation_kind: string;
	readonly payload: unknown;
	readonly rationale: string | null;
	readonly review_context?: ProposalReviewContext;
	readonly status: "pending" | "deciding" | "accepted" | "rejected" | "error";
}

// Plain *vanilla* zustand store so actions are callable outside React render — see docs/design/web-store.md
const initialState = (): ChatState => ({ threads: {}, proposals: {} });

const store = createStore<ChatState>()(() => initialState());

/** Read the raw state (test + bridge use this; components use the hooks). */
export function getChatState(): ChatState {
	return store.getState();
}

/** Reset to empty state (replace mode) — for test isolation. */
export function resetChatStore(): void {
	store.setState(initialState(), true);
}

let idCounter = 0;
/** Monotonic local message id. Live messages are client-minted, not wire ids. */
export function nextMessageId(): string {
	idCounter += 1;
	return `m${idCounter}`;
}

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

export function setFocusedThread(threadId: string): void {
	store.setState((s) => ({ ...s, focusedThreadId: threadId }));
}

/** Clear the focused thread (New Chat → null → next send mints a thread). */
export function clearFocusedThread(): void {
	store.setState((s) => ({ ...s, focusedThreadId: undefined }));
}

/** Set a thread's reactive hydration status — drives the focus-hydrate gate and the skeleton-vs-error render (issue #108). */
export function setHydrationStatus(
	threadId: string,
	status: HydrationStatus,
): void {
	store.setState((s) =>
		withThread(s, threadId, (t) => ({ ...t, hydration: status })),
	);
}

/** A thread's hydration status, `undefined` if it has never hydrated. Non-reactive read for the focus-hydrate gate. */
export function getHydrationStatus(
	threadId: string,
): HydrationStatus | undefined {
	return store.getState().threads[threadId]?.hydration;
}

/** Attach (or replace) the pending Proposal for `runId`, keyed by the parked Run's id (ADR-0025). */
export function setPendingProposal(proposal: PendingProposal): void {
	store.setState((s) => ({
		...s,
		proposals: { ...s.proposals, [proposal.run_id]: proposal },
	}));
}

/** Move a Proposal to a new review `status`; no-op if none is attached for `runId`. */
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

/** Drop the Proposal attached to `runId` (e.g. its parked Run was cancelled — there is nothing left to review); no-op if none. */
export function clearProposal(runId: string): void {
	store.setState((s) => {
		if (s.proposals[runId] === undefined) {
			return s;
		}
		const { [runId]: _dropped, ...rest } = s.proposals;
		return { ...s, proposals: rest };
	});
}

/** Clear the snapshot-applied bit for `runId` so the resume snapshot SETs (not APPENDs) — see docs/design/web-store.md (ADR-0025). */
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

/** Append a live (streaming) assistant message before the run id is known; {@link attachRun} promotes it. */
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
 * Does NOT pre-mark `snapshotApplied` — snapshot-vs-resubscribe interplay, see docs/design/web-store.md.
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

/** Non-destructively fold fetched (older) history in front of a thread that became live mid-`thread/get`; skips runs already present locally. */
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

/** Settle any tool call still marked `running` when its Run terminates (the terminal `tool_call` boundary is ephemeral; ADR-0022). */
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
 * SET-vs-APPEND rule: the FIRST `text_delta` after subscribe is the cumulative
 * snapshot → SET; subsequent deltas → APPEND. On `done` finalize + clear `activeRunId`.
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
			// Upsert: `started` appends a `running` row, terminal flips the matching row.
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
			// Terminal worker error (ADR-0006): mark incomplete, attach the message, clear the active run.
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
			// Terminal but NOT a failure (ADR-0014): mark incomplete, no `error` attached. Core mirrors this server-side.
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

		// done: finalize the assistant message and clear the active run.
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

/** Reactive hydration status for a thread, `null` if it has never hydrated. */
export function useHydrationStatus(threadId: string): HydrationStatus | null {
	return useStore(store, (s) => s.threads[threadId]?.hydration ?? null);
}

/** The pending/decided Proposal attached to `runId`, `null` if none. */
export function useProposalForRun(runId: string): PendingProposal | null {
	return useStore(store, (s) => s.proposals[runId] ?? null);
}
