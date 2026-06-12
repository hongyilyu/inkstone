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

/** Map a wire `MessageView` to the live {@link Message}, narrowing role/status via defensive guards — see docs/design/web-store.md. */
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
 * On failure nothing loads (no-op, not a throw); the returned Promise always resolves.
 * Became-live handling (send during the fetch window) folds history in non-destructively
 * via {@link prependHistory} instead of replacing — see docs/design/web-store.md.
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
		// Re-read state AFTER the await: a send during the fetch window may have turned this thread live.
		const live = getChatState().threads[threadId];
		const becameLive =
			live?.activeRunId !== undefined || (live?.messages.length ?? 0) > 0;
		if (becameLive) {
			// Keep the live turn intact; fold history in front and do NOT resubscribe a settled history run.
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

/** Hydrate the focused thread on focus change when it is non-null and not already live (slice 13). */
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
