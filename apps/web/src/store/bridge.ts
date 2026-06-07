import { WsClient, type RunId, type WsError } from "@inkstone/ui-sdk";
import { Effect, Fiber, Stream } from "effect";
import type { WsRuntime } from "../runtime.js";
import {
	appendUserMessage,
	attachRun,
	applyEvent,
	getChatState,
	markMessageIncomplete,
	nextMessageId,
	seedAssistantMessage,
	setFocusedThread,
	setPendingProposal,
	setProposalStatus,
} from "./chat.js";
import { markThreadHydrated } from "./hydration-set.js";

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

/** The global proposal-notification stream fiber, if started. */
let proposalFiber: Fiber.RuntimeFiber<void> | undefined;

/** Clear retained fibers — for test isolation (runtime disposal interrupts them). */
export function resetBridge(): void {
	fibers.clear();
	proposalFiber = undefined;
}

/**
 * The outcome of a send. Default to a returned discriminated result (not an
 * `onError` callback) so callers learn of a failure synchronously off the
 * awaited promise (FEATURE-PLAN slice C).
 */
export type SendResult = { ok: true } | { ok: false; error: unknown };

/**
 * Optimistically seed a turn into `threadId`: append the completed user message,
 * then a live (streaming) assistant message, returning the seeded assistant id.
 * Shared by {@link send} and {@link sendNewThread} — the ONLY ordering
 * difference is when it's called (see each caller), not what it does.
 */
function seedTurn(threadId: string, text: string): string {
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
	return assistantId;
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
				.pipe(
					Stream.takeUntil(
						(event) => event.kind === "done" || event.kind === "error",
					),
				),
			(event) => Effect.sync(() => applyEvent(threadId, runId, event)),
		);
	}).pipe(Effect.ensuring(Effect.sync(() => fibers.delete(runId))));

	fibers.set(runId, runtime.runFork(program));
}

/**
 * Send a prompt into a (focused) thread: append the user message, seed a live
 * assistant message, start the Run, then fork its stream. A failed send flips
 * the assistant message to `incomplete` (Q7) and returns `{ ok: false, error }`.
 */
export async function send(
	runtime: WsRuntime,
	threadId: string,
	text: string,
): Promise<SendResult> {
	// The thread is now live locally — its messages + stream are seeded here, so
	// the hydrate-on-focus effect must not re-hydrate it (slice 13 guard).
	markThreadHydrated(threadId);
	const assistantId = seedTurn(threadId, text);

	const post = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.postMessage(threadId, text);
	});

	try {
		const runId = await runtime.runPromise(post);
		attachRun(threadId, assistantId, runId);
		startRunStream(runtime, threadId, runId);
		return { ok: true };
	} catch (error) {
		// postMessage failed (typed failure or defect surfaced as a rejected
		// promise) → mark the seeded assistant message incomplete and surface it.
		markMessageIncomplete(threadId, assistantId);
		return { ok: false, error };
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
): Promise<SendResult> {
	const create = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.threadCreate(text);
	});

	try {
		const { thread_id, run_id } = await runtime.runPromise(create);
		setFocusedThread(thread_id);
		// The freshly-minted thread is live (seeded + streamed below); mark it so
		// focusing it does NOT trigger a thread/get hydrate (slice 13 guard).
		markThreadHydrated(thread_id);
		const assistantId = seedTurn(thread_id, text);
		attachRun(thread_id, assistantId, run_id);
		startRunStream(runtime, thread_id, run_id);
		return { ok: true };
	} catch (error) {
		// threadCreate failed before any thread was minted — nothing was seeded,
		// so there is no orphaned bubble to mark incomplete. Surface the failure
		// so the caller can tell the user (instead of silently swallowing it).
		return { ok: false, error };
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

// --- proposals (ADR-0025) ---------------------------------------------------

/**
 * Fork the global `proposalNotifications()` stream and drive each notification
 * into the store. On `pending` → fetch the Proposal (`proposal/get`) and attach
 * it to its parked Run keyed by `run_id`; on `changed` → update its review
 * status. Started ONCE for the chat surface (idempotent — a second call while a
 * fiber is live is a no-op).
 */
export function startProposalStream(runtime: WsRuntime): void {
	if (proposalFiber !== undefined) {
		return;
	}
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		yield* Stream.runForEach(client.proposalNotifications(), (n) =>
			Effect.gen(function* () {
				if (n.kind === "pending") {
					const p = yield* client.proposalGet(n.run_id);
					setPendingProposal({
						proposal_id: p.proposal_id,
						run_id: p.run_id,
						kind: p.kind,
						change_kind: p.change_kind,
						data: p.data,
						rationale: p.rationale,
						status: "pending",
					});
				} else {
					setProposalStatus(n.run_id, n.status);
				}
				// A `proposal/get` failure (rare; the Run un-parked between the
				// notification and the fetch) must not tear down the whole stream.
			}).pipe(Effect.catchAll(() => Effect.void)),
		);
	}).pipe(Effect.ensuring(Effect.sync(() => (proposalFiber = undefined))));

	proposalFiber = runtime.runFork(program);
}

/**
 * Decide a parked Run's Proposal (accept/reject/edit) and resume the Run. Flips
 * the card to `deciding`, calls `proposal/decide`, then on success sets the
 * decided status AND re-subscribes to the Run so the resume tail (parked →
 * running → completed, ADR-0022 snapshot-then-tail) streams into the assistant
 * bubble. A failed decide flips the card to `error` so the user can retry.
 *
 * An `edit` carries the user's `editedPayload` (the Todo `data`); Core
 * re-validates it and applies-in-one-step (ADR-0025), so the resume tail
 * behaves exactly like an accept. A decide already in flight short-circuits (no
 * double-submit); the stale parked stream fiber is interrupted before
 * re-subscribing so the resume tail has a single consumer.
 */
export async function decideProposal(
	runtime: WsRuntime,
	runId: RunId,
	decision: "accept" | "reject" | "edit",
	editedPayload?: unknown,
): Promise<void> {
	const proposal = getChatState().proposals[runId];
	if (proposal === undefined) {
		return;
	}
	// Double-submit guard (M1): a decide is already in flight. Returning here
	// stops a fast double-click from firing a second `proposal/decide` that
	// races behind the first — the Run un-parks after the first decide, so the
	// second hits Core as `proposal_not_pending` and its catch would stomp an
	// accept that actually succeeded with a spurious `error`. Retry from
	// `error` is still allowed (only `deciding` short-circuits).
	if (proposal.status === "deciding") {
		return;
	}
	setProposalStatus(runId, "deciding");

	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.proposalDecide({
			proposal_id: proposal.proposal_id,
			decision,
			...(decision === "edit" ? { edited_payload: editedPayload } : {}),
		});
	});

	try {
		const result = await runtime.runPromise(program);
		setProposalStatus(runId, result.status);
		// Re-subscribe to catch the resume tail. The thread that holds this run's
		// assistant turn drives the subscribe; find it by run id.
		const threadId = findThreadForRun(runId);
		if (threadId !== undefined) {
			// Stale-fiber guard (M2): a parked Run's forwarder closes with NO
			// terminal event, so the original `subscribeRun` fiber (bounded by
			// `takeUntil(done|error)`) never completed and is still blocked on
			// the per-run queue. Interrupt it BEFORE re-subscribing so exactly
			// one consumer drains the resume tail — two consumers would split a
			// multi-chunk continuation between them and corrupt the text.
			interruptRun(runtime, runId);
			startRunStream(runtime, threadId, runId);
		}
	} catch {
		setProposalStatus(runId, "error");
	}
}

/** The thread holding an assistant message for `runId`, if any. */
function findThreadForRun(runId: RunId): string | undefined {
	const { threads } = getChatState();
	for (const [threadId, thread] of Object.entries(threads)) {
		if (thread.messages.some((m) => m.run_id === runId)) {
			return threadId;
		}
	}
	return undefined;
}
