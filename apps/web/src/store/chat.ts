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

/**
 * One item in an assistant turn's ordered timeline (ADR-0045): a contiguous run
 * of text, a tool-call boundary, or a positional marker for the Proposal card.
 * The `proposal` segment carries ONLY `runId` — the {@link PendingProposal} map
 * stays the source of interactive state; this segment just says "the card renders
 * HERE in the timeline". The union is left open for a future `reasoning` kind.
 */
export type Segment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool_call"; readonly call: ToolCall }
	| { readonly kind: "proposal"; readonly runId: string };

/** The canonical live UI message; mirrors the wire `MessageView` shape. */
export interface Message {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly status: "streaming" | "completed" | "incomplete";
	readonly run_id: string;
	/**
	 * The turn's ordered timeline (ADR-0045) — the SINGLE source of truth: both the
	 * bubble's render source AND where the flat reply text derives from (via
	 * {@link concatText}, for the copy button / ⌘K search-match / typing-indicator /
	 * retry). Built incrementally (live, via the segment builders) or read verbatim
	 * from the wire `segments[]` (hydration). A user message carries a single `text`
	 * segment; an assistant turn interleaves text/tool_call/proposal items in order.
	 */
	readonly segments: readonly Segment[];
	/** Worker/provider failure message when a Run terminates with an `error` event (ADR-0006). */
	readonly error?: string;
}

/** Concatenate the text of every `text` segment in order — the single source for the
 * flat reply text the copy button, ⌘K search-match, typing-indicator, and retry read
 * (ADR-0045: there is no denormalized flat `text`; it derives from segments). */
export function concatText(segments: readonly Segment[]): string {
	let text = "";
	for (const seg of segments) {
		if (seg.kind === "text") text += seg.text;
	}
	return text;
}

/**
 * A message as constructed by a caller (the bridge's optimistic seed, a test): the
 * stored {@link Message} minus its required `segments`, which the store derives. A
 * caller MAY supply `segments` explicitly to seed a specific timeline (hydration, a
 * user message's single text segment, tests); otherwise the message opens with an
 * EMPTY timeline (a fresh assistant turn the live builders then fill).
 */
export type MessageInput = Omit<Message, "segments"> & {
	readonly segments?: readonly Segment[];
};

/** Normalize a {@link MessageInput} into a stored {@link Message}: keep an explicit
 * `segments` if supplied, else open with an EMPTY timeline (ADR-0045 — text/tool
 * segments arrive via the live builders or the wire, never a flat-field derivation). */
function withSegments(input: MessageInput): Message {
	return { ...input, segments: input.segments ?? [] };
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
	store.setState((s) => {
		// Park the Run and write the proposals map exactly as before, THEN drop a
		// `proposal` segment into the timeline (skip-if-present) — the seam where a
		// Proposal enters the ordered turn (ADR-0045); it does not flow through applyEvent.
		const parked: ChatState = {
			...s,
			runs: parkRun(s.runs, proposal.run_id),
			proposals: { ...s.proposals, [proposal.run_id]: proposal },
		};
		return attachProposalSegment(parked, proposal.run_id);
	});
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

/**
 * Reconstruct a DECIDED Proposal from `thread/get` rehydration (ADR-0044) so the
 * settled `ProposalCard` (e.g. "Applied.") survives reload. Skips if a Proposal
 * is already attached for `runId` — a live pending/deciding one (the became-live
 * window, or a notification that beat hydration) must NOT be clobbered by the
 * settled-history view. The reconstructed record carries no `payload`/`rationale`/
 * `resolved_plan`: the decided card reads only `status` + `mutation_kind`, and
 * every payload reader degrades a missing payload to empty (it never reaches the
 * interactive branch once `status` is accepted/rejected).
 */
export function rehydrateDecidedProposal(proposal: PendingProposal): void {
	store.setState((s) => {
		if (s.proposals[proposal.run_id] !== undefined) {
			return s;
		}
		const withProposal: ChatState = {
			...s,
			proposals: { ...s.proposals, [proposal.run_id]: proposal },
		};
		// Give the rehydrated card a timeline slot too (skip-if-present, ADR-0045).
		// Appended at the END after the hydration-built segments (legacy order this
		// slice; slice 3 moves it to its true run_steps position via the wire).
		return attachProposalSegment(withProposal, proposal.run_id);
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

export function appendUserMessage(
	threadId: string,
	message: MessageInput,
): void {
	const normalized = withSegments(message);
	store.setState((s) =>
		withThread(s, threadId, (t) => ({
			...t,
			messages: [...t.messages, normalized],
		})),
	);
}

/** Append a live (streaming) assistant message before the run id is known; {@link attachRun} promotes it. */
export function seedAssistantMessage(
	threadId: string,
	message: MessageInput,
): void {
	const normalized = withSegments(message);
	store.setState((s) =>
		withThread(s, threadId, (t) => ({
			...t,
			messages: [...t.messages, normalized],
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

// ── Segment timeline builders (ADR-0045) ──────────────────────────────────────
// The web mirror of Core's run_steps sequencer: each Run Event extends the ordered
// `segments[]` so the live render is the same shape the reload will read (slice 3).

/**
 * Thread a `text_delta` into the timeline (ADR-0045), mirroring the flat-text
 * SET-vs-APPEND rule (ADR-0022) so `concatText(segments) === flat text` always holds:
 *
 * - **APPEND** (disarmed tail): extend the OPEN trailing text segment; if the trailing
 *   segment is non-text (a tool/proposal just sealed the run) or the timeline is empty,
 *   OPEN a fresh text segment — the web mirror of Core's open-on-first-delta.
 * - **SET** (armed cumulative snapshot): the delta is the cumulative concat of ALL the
 *   turn's text so far (`group_concat`, no boundary markers — `select_run_snapshot`), so
 *   it replaces EVERY existing text segment, not just the trailing one. Collapse all text
 *   segments into ONE carrying the snapshot at the position of the FIRST text segment, and
 *   drop the rest — PRESERVING the interleaved tool_call/proposal segments' order. If no
 *   text segment exists yet, OPEN one at the end. Replacing only the last text segment (the
 *   prior rule) left earlier text segments in place, so a post-park resume snapshot that
 *   re-includes pre-park prose DUPLICATED it (concatText = "A" + "A B" ≠ flat "A B").
 */
function appendTextSegment(
	segments: readonly Segment[],
	delta: string,
	armed: boolean,
): readonly Segment[] {
	if (armed) {
		return setCumulativeText(segments, delta);
	}
	const last = segments[segments.length - 1];
	if (last?.kind === "text") {
		return [
			...segments.slice(0, -1),
			{ kind: "text", text: last.text + delta },
		];
	}
	return [...segments, { kind: "text", text: delta }];
}

/**
 * Reconcile a cumulative-snapshot SET into the timeline: the snapshot is the WHOLE
 * turn's text, so the result has exactly one text segment carrying it (at the first
 * existing text position) and keeps every non-text segment in its place. With no text
 * segment yet, the snapshot opens one at the end. This is what makes
 * `concatText(segments) === snapshot` hold even when the turn had multiple pre-snapshot
 * text runs (text→tool→text→park→resume) — the duplicated-prefix case the prior
 * last-text-only rule missed.
 */
function setCumulativeText(
	segments: readonly Segment[],
	snapshot: string,
): readonly Segment[] {
	const firstTextIndex = segments.findIndex((seg) => seg.kind === "text");
	if (firstTextIndex === -1) {
		return [...segments, { kind: "text", text: snapshot }];
	}
	const result: Segment[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (i === firstTextIndex) {
			result.push({ kind: "text", text: snapshot });
		} else if (seg.kind !== "text") {
			result.push(seg);
		}
		// Drop every other text segment — its content is already in the snapshot.
	}
	return result;
}

/** Upsert a `tool_call` segment by call id (ADR-0045): a new id appends a fresh
 * segment at the end of the timeline; a known id flips its call's status in place. */
function upsertToolSegment(
	segments: readonly Segment[],
	call: ToolCall,
): readonly Segment[] {
	const found = segments.some(
		(seg) => seg.kind === "tool_call" && seg.call.id === call.id,
	);
	if (!found) {
		return [...segments, { kind: "tool_call", call }];
	}
	return segments.map((seg) =>
		seg.kind === "tool_call" && seg.call.id === call.id
			? { kind: "tool_call", call: { ...seg.call, status: call.status } }
			: seg,
	);
}

/** Settle any `running` tool_call SEGMENT to `terminal` when its Run ends (the
 * segment-aware twin of {@link settleRunningToolCalls}; the lost-boundary case). */
function settleRunningToolSegments(
	segments: readonly Segment[],
	terminal: "completed" | "error",
): readonly Segment[] {
	return segments.map((seg) =>
		seg.kind === "tool_call" && seg.call.status === "running"
			? { kind: "tool_call", call: { ...seg.call, status: terminal } }
			: seg,
	);
}

/** Append a `proposal` segment for `runId` at the current end of the timeline,
 * unless one is already present (skip-if-present): the seam where a Proposal enters
 * the timeline (it does NOT flow through {@link applyEvent}) — see {@link setPendingProposal}. */
function appendProposalSegment(
	segments: readonly Segment[],
	runId: string,
): readonly Segment[] {
	if (segments.some((seg) => seg.kind === "proposal")) {
		return segments;
	}
	return [...segments, { kind: "proposal", runId }];
}

/** Attach a `proposal` segment (skip-if-present) to the assistant message owning
 * `runId` within its thread — the {@link setPendingProposal} / {@link
 * rehydrateDecidedProposal} timeline seam, shared so both enter the timeline identically.
 * The owning thread is the run→thread index when a record exists (live), else a scan
 * of message run ids (a rehydrated decided proposal on a settled Run has no record). */
function attachProposalSegment(s: ChatState, runId: string): ChatState {
	const threadId = s.runs[runId]?.threadId ?? threadIdForRun(s, runId);
	if (threadId === undefined) {
		return s;
	}
	return updateRunMessage(s, threadId, runId, (m) => ({
		...m,
		segments: appendProposalSegment(m.segments, runId),
	}));
}

/** The thread holding an assistant message for `runId` (the rehydration fallback when
 * no live {@link RunRecord} exists); `undefined` if no message references the run. */
function threadIdForRun(s: ChatState, runId: string): string | undefined {
	for (const [id, thread] of Object.entries(s.threads)) {
		if (
			thread.messages.some((m) => m.role === "assistant" && m.run_id === runId)
		) {
			return id;
		}
	}
	return undefined;
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
 * Transform the assistant bubble for `runId` within its thread. Owns the
 * "locate this run's bubble" predicate ONCE (it was open-coded across every
 * event branch, in two spellings). Routes through {@link withThread} so
 * unrelated threads keep stable object identities (the reference-stability gate
 * in chat.selectors.test.tsx).
 */
function updateRunMessage(
	s: ChatState,
	threadId: string,
	runId: string,
	transform: (m: Message) => Message,
): ChatState {
	return withThread(s, threadId, (t) => ({
		...t,
		messages: t.messages.map((m) =>
			m.role === "assistant" && m.run_id === runId ? transform(m) : m,
		),
	}));
}

/**
 * Settle a terminated Run: clear the thread's `activeRunId` (if it still points
 * at this run) and flip the keyed record to `terminal`. Message-free — the
 * per-message finalize (status + {@link settleRunningToolCalls}) is applied
 * first via {@link updateRunMessage}, so this only ever touches `activeRunId`
 * and `runs`.
 */
function settleTerminal(
	s: ChatState,
	threadId: string,
	runId: string,
): ChatState {
	return {
		...withThread(s, threadId, (t) => ({
			...t,
			activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
		})),
		runs: terminateRun(s.runs, runId),
	};
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
			// disarmed tail APPENDs (ADR-0022 snapshot/tail boundary). The armed bit
			// drives the open-trailing-text segment (ADR-0045); `segments` is the sole
			// text source, so the flat reply text derives from it via `concatText`.
			const armed = s.runs[runId]?.snapshotArmed ?? true;
			const next = updateRunMessage(s, threadId, runId, (m) => ({
				...m,
				segments: appendTextSegment(m.segments, event.delta, armed),
			}));
			// Disarm the snapshot bit — text_delta's OWN concern, fits neither helper.
			const run = next.runs[runId];
			if (run === undefined) {
				return next;
			}
			return {
				...next,
				runs: { ...next.runs, [runId]: { ...run, snapshotArmed: false } },
			};
		}

		if (event.kind === "tool_call") {
			// Upsert into the timeline: `started` appends a `running` segment, a
			// terminal status flips the matching one in place (ADR-0045).
			const status = event.status === "started" ? "running" : event.status;
			const call: ToolCall = {
				id: event.tool_call_id,
				name: event.name,
				status,
				arg: event.arg,
			};
			return updateRunMessage(s, threadId, runId, (m) => ({
				...m,
				segments: upsertToolSegment(m.segments, call),
			}));
		}

		if (event.kind === "error") {
			// Terminal worker error (ADR-0006): mark incomplete, attach the message, clear the active run.
			const next = updateRunMessage(s, threadId, runId, (m) => ({
				...m,
				status: "incomplete",
				error: event.message,
				segments: settleRunningToolSegments(m.segments, "error"),
			}));
			return settleTerminal(next, threadId, runId);
		}

		if (event.kind === "cancelled") {
			// Terminal but NOT a failure (ADR-0014): mark incomplete, no `error` attached. Core mirrors this server-side.
			const next = updateRunMessage(s, threadId, runId, (m) => ({
				...m,
				status: "incomplete",
				segments: settleRunningToolSegments(m.segments, "completed"),
			}));
			return settleTerminal(next, threadId, runId);
		}

		// done: finalize the assistant message and clear the active run.
		const next = updateRunMessage(s, threadId, runId, (m) => ({
			...m,
			status: "completed",
			segments: settleRunningToolSegments(m.segments, "completed"),
		}));
		return settleTerminal(next, threadId, runId);
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
