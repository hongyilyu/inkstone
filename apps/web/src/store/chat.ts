import type { RunEventValue } from "@inkstone/ui-sdk";
import { useSyncExternalStore } from "react";

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
// Plain external store (NOT Effect-bound, NO zustand). A tiny module-level
// object with getSnapshot/subscribe/setState, consumed via React 19's built-in
// `useSyncExternalStore`. See OPEN-QUESTIONS.md: "zustand pattern" = the shape,
// not the dependency. ADR-0020: Effect owns the wire; React state is plain.
// ---------------------------------------------------------------------------

const initialState = (): ChatState => ({ threads: {} });

let state: ChatState = initialState();
const listeners = new Set<() => void>();

function setState(updater: (s: ChatState) => ChatState): void {
	state = updater(state);
	for (const listener of listeners) {
		listener();
	}
}

function getSnapshot(): ChatState {
	return state;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Read the raw state (test + bridge use this; components use the hooks). */
export function getChatState(): ChatState {
	return state;
}

/** Reset to empty state — for test isolation. */
export function resetChatStore(): void {
	state = initialState();
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
	setState((s) => ({ ...s, focusedThreadId: threadId }));
}

export function appendUserMessage(threadId: string, message: Message): void {
	setState((s) =>
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
	setState((s) =>
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
	setState((s) => {
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

/** Mark a seeded assistant message failed by id (failed-send path, Q7). */
export function markMessageIncomplete(
	threadId: string,
	messageId: string,
): void {
	setState((s) => {
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
	setState((s) => {
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
	return useSyncExternalStore(
		subscribe,
		() => getSnapshot().threads[threadId]?.messages ?? EMPTY_MESSAGES,
	);
}

/** Focused thread id, `null` at the React boundary (undefined internally). */
export function useFocusedThreadId(): string | null {
	return useSyncExternalStore(
		subscribe,
		() => getSnapshot().focusedThreadId ?? null,
	);
}

/** Active run id for a thread, `null` at the React boundary. */
export function useActiveRunId(threadId: string): string | null {
	return useSyncExternalStore(
		subscribe,
		() => getSnapshot().threads[threadId]?.activeRunId ?? null,
	);
}
