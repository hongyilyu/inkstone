import type { RunEventValue } from "@inkstone/ui-sdk";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

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

const initialState = (): ChatState => ({ threads: {} });

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
		const messages = thread.messages.map((m): Message =>
			m.id === messageId ? { ...m, run_id: runId } : m,
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
		const messages = thread.messages.map((m): Message =>
			m.id === messageId ? { ...m, status: "incomplete" } : m,
		);
		return withThread(s, threadId, (t) => ({ ...t, messages }));
	});
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
			const messages = thread.messages.map((m): Message =>
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

		if (event.kind === "error") {
			// A worker-emitted error (ADR-0006) is terminal: flip the
			// assistant message to `incomplete` and clear the active run.
			// Richer error rendering (surfacing the message) is a later UI
			// slice; here we just finalize so the stream fiber settles.
			const messages = thread.messages.map((m): Message =>
				m.role === "assistant" && m.run_id === runId
					? { ...m, status: "incomplete" }
					: m,
			);
			return withThread(s, threadId, (t) => ({
				...t,
				messages,
				activeRunId: t.activeRunId === runId ? undefined : t.activeRunId,
			}));
		}

		// done → finalize the assistant message and clear the active run.
		const messages = thread.messages.map((m): Message =>
			m.role === "assistant" && m.run_id === runId
				? { ...m, status: "completed" }
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
