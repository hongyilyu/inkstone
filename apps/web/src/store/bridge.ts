import { type RunId, WsClient, type WsError } from "@inkstone/ui-sdk";
import { Effect, Fiber, Stream } from "effect";
import type { WsRuntime } from "../runtime.js";
import {
	appendUserMessage,
	applyEvent,
	attachRun,
	getChatState,
	markMessageIncomplete,
	nextMessageId,
	resetSnapshot,
	seedAssistantMessage,
	setFocusedThread,
	setPendingProposal,
	setProposalStatus,
} from "./chat.js";
import { markThreadHydrated } from "./hydration-set.js";

// Thin imperative seam between Effect (owns wire/streams) and the plain React store — see docs/design/web-store.md (ADR-0020).
// Each run's stream fiber is retained keyed by run id so it can be interrupted on unmount (structured cancellation, Q18 A′).
const fibers = new Map<RunId, Fiber.RuntimeFiber<void, WsError>>();

/** The global proposal-notification stream fiber, if started. */
let proposalFiber: Fiber.RuntimeFiber<void> | undefined;

/** Clear retained fibers — for test isolation (runtime disposal interrupts them). */
export function resetBridge(): void {
	fibers.clear();
	proposalFiber = undefined;
}

/** The outcome of a send — a discriminated result so callers learn of failure off the awaited promise. */
export type SendResult = { ok: true } | { ok: false; error: unknown };

/** Optimistically seed a turn into `threadId` (completed user + live assistant), returning the seeded assistant id. */
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

/** Fork the SDK stream for `runId` and drive each event into the store; the fiber is retained until its terminal event. */
export function startRunStream(
	runtime: WsRuntime,
	threadId: string,
	runId: RunId,
): void {
	// Hold the fiber so the finalizer can delete ONLY its own map entry.
	let self: Fiber.RuntimeFiber<void, WsError> | undefined;
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		yield* Stream.runForEach(
			client
				.subscribeRun(runId)
				.pipe(
					Stream.takeUntil(
						(event) =>
							event.kind === "done" ||
							event.kind === "error" ||
							event.kind === "cancelled",
					),
				),
			(event) => Effect.sync(() => applyEvent(threadId, runId, event)),
		);
	}).pipe(
		// Identity-aware cleanup (M2): delete only when the map still points at THIS fiber — see docs/design/web-store.md.
		Effect.ensuring(
			Effect.sync(() => {
				if (fibers.get(runId) === self) {
					fibers.delete(runId);
				}
			}),
		),
	);

	self = runtime.runFork(program);
	fibers.set(runId, self);
}

/** Send a prompt into a focused thread: seed the turn, start the Run, fork its stream; a failed send returns `{ ok: false }`. */
export async function send(
	runtime: WsRuntime,
	threadId: string,
	text: string,
): Promise<SendResult> {
	// Mark live so the hydrate-on-focus effect does not re-hydrate it (slice 13 guard).
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
		// postMessage failed: mark the seeded assistant message incomplete and surface it.
		markMessageIncomplete(threadId, assistantId);
		return { ok: false, error };
	}
}

/** First-message path: mint a thread via `threadCreate`, then seed + stream like {@link send} — see docs/design/web-store.md. */
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
		// Mark live so focusing it does NOT trigger a thread/get hydrate (slice 13 guard).
		markThreadHydrated(thread_id);
		const assistantId = seedTurn(thread_id, text);
		attachRun(thread_id, assistantId, run_id);
		startRunStream(runtime, thread_id, run_id);
		return { ok: true };
	} catch (error) {
		// threadCreate failed before any thread was minted — nothing seeded, no orphaned bubble. Surface the failure.
		return { ok: false, error };
	}
}

/** Whether a run's stream fiber is currently tracked — test helper (M2). */
export function hasRunFiber(runId: RunId): boolean {
	return fibers.has(runId);
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

/** Fork the global `proposalNotifications()` stream into the store, fetching+attaching on `pending` (idempotent; ADR-0025). */
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
						mutation_kind: p.mutation_kind,
						payload: p.payload,
						rationale: p.rationale,
						review_context: p.review_context,
						status: "pending",
					});
				} else {
					setProposalStatus(n.run_id, n.status);
				}
				// A `proposal/get` failure must not tear down the whole stream.
			}).pipe(Effect.catchAll(() => Effect.void)),
		);
	}).pipe(Effect.ensuring(Effect.sync(() => (proposalFiber = undefined))));

	proposalFiber = runtime.runFork(program);
}

/** Decide a parked Run's Proposal (accept/reject/edit) and re-subscribe for the resume tail — see docs/design/web-store.md (ADR-0025). */
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
	// Double-submit guard (M1): short-circuit a decide already in flight — see docs/design/web-store.md.
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
		const threadId = findThreadForRun(runId);
		if (threadId !== undefined) {
			// Stale-fiber + snapshot-reset guard (M2): interrupt the parked fiber, then
			// reset the snapshot bit so the resume's first text_delta SETs — see docs/design/web-store.md.
			interruptRun(runtime, runId);
			resetSnapshot(threadId, runId);
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
