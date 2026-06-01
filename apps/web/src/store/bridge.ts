import { WsClient, type RunId, type WsError } from "@inkstone/ui-sdk";
import { Effect, Fiber, Stream } from "effect";
import type { WsRuntime } from "../runtime.js";
import {
	appendUserMessage,
	attachRun,
	applyEvent,
	markMessageIncomplete,
	nextMessageId,
	seedAssistantMessage,
	setFocusedThread,
} from "./chat.js";

/**
 * The thin imperative seam between Effect (which owns the wire/streams/runtime)
 * and the plain React store. Per ADR-0020, the bridge forks the SDK stream on
 * the runtime and pushes events into the store via {@link applyEvent}. No
 * Effect React-binding lib; the store stays plain.
 *
 * Structured cancellation (Q18 A′): each run's stream fiber is retained keyed by
 * run id so it can be interrupted on unmount. A run's stream is bounded by
 * `Stream.takeUntil(done)`, so on `done` the `runForEach` completes and the
 * fiber finishes on its own — independent of the focused thread.
 */
const fibers = new Map<RunId, Fiber.RuntimeFiber<void, WsError>>();

/** Clear retained fibers — for test isolation (runtime disposal interrupts them). */
export function resetBridge(): void {
	fibers.clear();
}

/**
 * Fork the SDK stream for `runId` and drive each event into the store. The
 * fiber is retained keyed by run id and removed when the stream completes (on
 * `done`, via `takeUntil`) so it survives focus changes until its own `done`.
 */
export function startRunStream(
	runtime: WsRuntime,
	threadId: string,
	runId: RunId,
): void {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		yield* Stream.runForEach(
			client
				.subscribeRun(runId)
				.pipe(Stream.takeUntil((event) => event.kind === "done")),
			(event) => Effect.sync(() => applyEvent(threadId, runId, event)),
		);
	}).pipe(Effect.ensuring(Effect.sync(() => fibers.delete(runId))));

	fibers.set(runId, runtime.runFork(program));
}

/**
 * Send a prompt into a (focused) thread: append the user message, seed a live
 * assistant message, start the Run, then fork its stream. A failed send flips
 * the assistant message to `incomplete` (Q7).
 */
export async function send(
	runtime: WsRuntime,
	threadId: string,
	text: string,
): Promise<void> {
	appendUserMessage(threadId, {
		id: nextMessageId(),
		role: "user",
		status: "completed",
		text,
		run_id: "",
	});
	const assistantId = nextMessageId();
	seedAssistantMessage(threadId, {
		id: assistantId,
		role: "assistant",
		status: "streaming",
		text: "",
		run_id: "",
	});

	const post = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.postMessage(threadId, text);
	});

	try {
		const runId = await runtime.runPromise(post);
		attachRun(threadId, assistantId, runId);
		startRunStream(runtime, threadId, runId);
	} catch {
		// postMessage failed (typed failure or defect surfaced as a rejected
		// promise) → mark the seeded assistant message incomplete.
		markMessageIncomplete(threadId, assistantId);
	}
}

/**
 * First-message path: no thread is focused yet, so mint one. `threadCreate`
 * returns `{thread_id, run_id}` in a single round trip; we then focus the new
 * thread, seed the same user + live-assistant pair as {@link send}, promote the
 * assistant message onto the run, and fork its stream. Mirrors {@link send} but
 * minting the thread first (the slice-11-deferred create-on-first-message path).
 *
 * Because the thread id only exists once `threadCreate` resolves, the optimistic
 * seed happens after the await (unlike {@link send}, which seeds into a known
 * thread up front). If `threadCreate` itself fails, nothing was minted or
 * seeded, so there is no orphaned bubble to mark — the user can retry.
 */
export async function sendNewThread(
	runtime: WsRuntime,
	text: string,
): Promise<void> {
	const create = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.threadCreate(text);
	});

	try {
		const { thread_id, run_id } = await runtime.runPromise(create);
		setFocusedThread(thread_id);
		appendUserMessage(thread_id, {
			id: nextMessageId(),
			role: "user",
			status: "completed",
			text,
			run_id: "",
		});
		const assistantId = nextMessageId();
		seedAssistantMessage(thread_id, {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "",
		});
		attachRun(thread_id, assistantId, run_id);
		startRunStream(runtime, thread_id, run_id);
	} catch {
		// threadCreate failed before any thread was minted — nothing to seed
		// or mark incomplete. No orphaned bubble is left behind.
	}
}

/** Interrupt a run's stream fiber (unmount / structured cancellation, Q18 A′). */
export function interruptRun(runtime: WsRuntime, runId: RunId): void {
	const fiber = fibers.get(runId);
	if (fiber === undefined) {
		return;
	}
	fibers.delete(runId);
	runtime.runFork(Fiber.interrupt(fiber));
}

/** Await a run's stream fiber to completion — test helper to flush the stream. */
export async function awaitRun(
	runtime: WsRuntime,
	runId: RunId,
): Promise<void> {
	const fiber = fibers.get(runId);
	if (fiber === undefined) {
		return;
	}
	await runtime.runPromise(Fiber.join(fiber));
}
