import type { ThreadGetResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { Effect } from "effect";
import { useEffect } from "react";
import type { WsRuntime } from "../runtime.js";
import { startRunStream } from "./bridge.js";
import {
	getChatState,
	loadThreadMessages,
	type Message,
	prependHistory,
} from "./chat.js";
import { isThreadHydrated, markThreadHydrated } from "./hydration-set.js";

export { markThreadHydrated, resetHydration } from "./hydration-set.js";

/**
 * Map a wire `MessageView` to the live {@link Message}, narrowing the wire
 * `role`/`status` STRINGS to the live literal unions WITHOUT casts.
 *
 * The wire schema types both as `S.String` (packages/protocol), but Core only
 * ever emits the known values. We narrow defensively via explicit guards: an
 * unknown role defaults to `assistant`, an unknown status to `completed` — so a
 * malformed frame paints as a finished assistant bubble rather than crashing or
 * leaving a phantom streaming row.
 */
export function toMessage(view: ThreadGetResult["messages"][number]): Message {
	const role: Message["role"] = view.role === "user" ? "user" : "assistant";
	const status: Message["status"] =
		view.status === "streaming" ||
		view.status === "completed" ||
		view.status === "incomplete"
			? view.status
			: "completed";
	return {
		id: view.id,
		role,
		status,
		text: view.text,
		run_id: view.run_id,
	};
}

/**
 * Hydrate a thread from `thread/get` and resume any streaming run (slice 13).
 *
 * Flow: run `threadGet(threadId)` on the runtime → map the wire messages to
 * live {@link Message}s → {@link loadThreadMessages} → for every message with
 * `status === "streaming"` AND a non-empty `run_id`, {@link startRunStream} to
 * resubscribe (the resubscribe's first cumulative `text_delta` SETs the text,
 * since `loadThreadMessages` left `snapshotApplied` unset).
 *
 * On failure (`WsError`) the effect's success branch never runs, so nothing is
 * loaded — a no-op, not a throw. This is what keeps `App.test` green: its stub
 * runtime returns a pending/erroring `threadGet`, so hydration quietly does
 * nothing. Returns a Promise that always resolves (errors are swallowed).
 *
 * Became-live handling: the composer stays live under the loading skeleton, so
 * the user can `send` into this thread DURING the in-flight `threadGet`. That
 * seeds an optimistic user+assistant turn and (via `attachRun`) an `activeRunId`.
 * An unconditional `loadThreadMessages` full-replace would then wipe the seeded
 * turn AND orphan its streamed reply (the assistant message id the live
 * `applyEvent` targets disappears). So when the thread became live we
 * NON-destructively {@link prependHistory} the fetched (older) turns in front of
 * the live turn instead of replacing — preserving prior conversation without
 * clobbering the in-flight one — and skip resubscribing (the live turn already
 * owns the active run; the fetched history is settled).
 */
export function hydrateThread(
	runtime: WsRuntime,
	threadId: string,
): Promise<void> {
	markThreadHydrated(threadId);
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		const result = yield* client.threadGet(threadId);
		const messages = result.messages.map(toMessage);
		// Re-read state AFTER the await: a send during the fetch window may have
		// turned this thread live. A live thread has an `activeRunId` (set once
		// `postMessage`/`threadCreate` resolves) OR already-seeded messages (the
		// optimistic pair, present even before the run id resolves).
		const live = getChatState().threads[threadId];
		const becameLive =
			live?.activeRunId !== undefined || (live?.messages.length ?? 0) > 0;
		if (becameLive) {
			// Keep the live turn intact; fold the fetched history in front of it.
			// Do NOT resubscribe a history run — its stream is settled, and the
			// live turn's stream is already running.
			prependHistory(threadId, messages);
			return;
		}
		loadThreadMessages(threadId, messages);
		for (const message of messages) {
			if (message.status === "streaming" && message.run_id !== "") {
				startRunStream(runtime, threadId, message.run_id);
			}
		}
	});
	return runtime.runPromise(program).then(
		() => undefined,
		() => undefined,
	);
}

/**
 * Hydrate the focused thread on focus change (slice 13). When `focusedThreadId`
 * becomes a non-null thread not already live, run {@link hydrateThread}. The
 * `hydrated` Set guards against re-hydrating + double-resubscribing the same
 * thread (it also holds locally-originated threads marked via
 * {@link markThreadHydrated}).
 */
export function useHydrateFocusedThread(
	runtime: WsRuntime,
	focusedThreadId: string | null,
): void {
	useEffect(() => {
		if (focusedThreadId !== null && !isThreadHydrated(focusedThreadId)) {
			void hydrateThread(runtime, focusedThreadId);
		}
	}, [runtime, focusedThreadId]);
}
