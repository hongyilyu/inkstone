import type { ProposalReviewContext, ResolvedNode } from "@inkstone/protocol";
import type { RunEventValue } from "@inkstone/ui-sdk";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** A tool call surfaced live within an assistant turn (ADR-0006 tool_call Run Event). */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "error";
	/** The tool's display argument (ADR-0043), e.g. a search query; absent for argless tools. */
	readonly arg?: string;
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

/**
 * Reactive hydrate-on-focus lifecycle (replaces the old non-reactive Set):
 * `loading` while `thread/get` is in flight, `error` on a transient failed fetch
 * (drives a recoverable retry affordance), `not_found` when Core reports the
 * Thread does not exist (`UnknownThreadError`, a dead-end with a Back-to-New-Chat
 * exit — ADR-0042), `ready` once history is live or locally-originated. Absent =
 * never hydrated.
 */
export type HydrationStatus = "loading" | "ready" | "error" | "not_found";

/** Per-thread state. The Run lifecycle (status / snapshot boundary / parked-ness) lives on {@link RunRecord}, keyed by run id. */
interface ThreadState {
	readonly messages: Message[];
	readonly activeRunId?: string;
	readonly hydration?: HydrationStatus;
}

/**
 * One keyed record per Run — the single place its live state is materialized,
 * rather than re-derived ad hoc across the store and bridge:
 *
 * - `status` — `running` while the subscribe tail flows, `parked` while a Proposal
 *   awaits a decision (no live tail), `terminal` once a done/error/cancelled
 *   settles it. "is this Run parked?" / "is it terminal?" become field reads.
 * - `threadId` — the run→thread index that replaces a linear scan of all threads.
 * - `snapshotArmed` — true when the NEXT `text_delta` is the cumulative snapshot
 *   (SET, not APPEND), per the ADR-0022 snapshot/tail boundary. Armed by
 *   {@link beginRunSubscription} (the single fresh-send AND resume verb) and read
 *   /cleared by {@link applyEvent} — no cross-file flag arming.
 */
interface RunRecord {
	readonly status: "running" | "parked" | "terminal";
	readonly threadId: string;
	readonly snapshotArmed: boolean;
}

interface ChatState {
	readonly threads: Record<string, ThreadState>;
	/** Live Run lifecycle records, keyed by run id (ADR-0022 boundary, ADR-0028 record-not-FSM). */
	readonly runs: Record<string, RunRecord>;
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
	/** The per-node create/reuse/ambiguous plan for an `apply_intent_graph`
	 * proposal (ADR-0042); absent for the single-entity kinds. */
	readonly resolved_plan?: readonly ResolvedNode[];
	readonly status: "pending" | "deciding" | "accepted" | "rejected" | "error";
}

// Plain *vanilla* zustand store so actions are callable outside React render — see docs/design/web-store.md
const initialState = (): ChatState => ({
	threads: {},
	runs: {},
	proposals: {},
});

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

/**
 * Begin (or resume) the live subscription for `runId`: materialize its record as
 * `running` and **arm the snapshot bit** so the next `text_delta` SETs the
 * cumulative snapshot rather than APPENDing (ADR-0022). This is the single verb
 * behind both a fresh send and a post-decide resume — arming here replaces the
 * old cross-file `resetSnapshot` discipline that caused the M1 duplicated-prefix bug.
 */
export function beginRunSubscription(threadId: string, runId: string): void {
	store.setState((s) => ({
		...s,
		runs: {
			...s.runs,
			[runId]: { status: "running", threadId, snapshotArmed: true },
		},
	}));
}

/** The Run record for `runId`, if one has been materialized (non-reactive read for the bridge). */
export function getRun(runId: string): RunRecord | undefined {
	return store.getState().runs[runId];
}

/** Whether `runId` is parked on a Proposal (no live tail) — a field read, not re-derived from Proposal status. */
export function isRunParked(runId: string): boolean {
	return store.getState().runs[runId]?.status === "parked";
}

/** The thread that owns `runId` — the run→thread index that replaces a linear thread scan. */
export function getRunThreadId(runId: string): string | undefined {
	return store.getState().runs[runId]?.threadId;
}

/** Attach (or replace) the pending Proposal for `runId` and park its Run (ADR-0025): a parked Run has no live tail. */
export function setPendingProposal(proposal: PendingProposal): void {
	store.setState((s) => ({
		...s,
		runs: parkRun(s.runs, proposal.run_id),
		proposals: { ...s.proposals, [proposal.run_id]: proposal },
	}));
}

/** Park `runId`'s record if it exists; a Proposal awaiting a decision has no live subscribe tail. */
function parkRun(runs: ChatState["runs"], runId: string): ChatState["runs"] {
	const run = runs[runId];
	if (run === undefined) {
		return runs;
	}
	return { ...runs, [runId]: { ...run, status: "parked" } };
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
 * Does NOT arm a Run snapshot — that is owned by {@link beginRunSubscription}
 * when the streaming run is (re)subscribed; see docs/design/web-store.md.
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

/** Mark `runId`'s record terminal; no-op if no record exists. The keyed companion to clearing `activeRunId`. */
function terminateRun(
	runs: ChatState["runs"],
	runId: string,
): ChatState["runs"] {
	const run = runs[runId];
	if (run === undefined) {
		return runs;
	}
	return { ...runs, [runId]: { ...run, status: "terminal" } };
}

/**
 * Apply a streamed run event to the thread's assistant message for `runId`.
 * SET-vs-APPEND rule: the FIRST `text_delta` after subscribe is the cumulative
 * snapshot → SET (driven by the record's armed `snapshotArmed` bit); subsequent
 * deltas → APPEND. A terminal event finalizes the bubble, clears `activeRunId`,
 * and flips the record to `terminal`.
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
			// Armed (or no record yet) → the cumulative snapshot SETs; an attached,
			// disarmed tail APPENDs (ADR-0022 snapshot/tail boundary).
			const armed = s.runs[runId]?.snapshotArmed ?? true;
			const messages = thread.messages.map(
				(m): Message =>
					m.role === "assistant" && m.run_id === runId
						? { ...m, text: armed ? event.delta : m.text + event.delta }
						: m,
			);
			const run = s.runs[runId];
			return {
				...withThread(s, threadId, (t) => ({ ...t, messages })),
				runs:
					run === undefined
						? s.runs
						: { ...s.runs, [runId]: { ...run, snapshotArmed: false } },
			};
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
					: [
							...existing,
							{
								id: event.tool_call_id,
								name: event.name,
								status,
								arg: event.arg,
							},
						];
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
			return {
				...withThread(s, threadId, (t) => ({
					...t,
					messages,
					activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
				})),
				runs: terminateRun(s.runs, runId),
			};
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
			return {
				...withThread(s, threadId, (t) => ({
					...t,
					messages,
					activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
				})),
				runs: terminateRun(s.runs, runId),
			};
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
		return {
			...withThread(s, threadId, (t) => ({
				...t,
				messages,
				activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
			})),
			runs: terminateRun(s.runs, runId),
		};
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
