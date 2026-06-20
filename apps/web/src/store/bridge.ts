import type { NodeDecision } from "@inkstone/protocol";
import { type RunId, WsClient, type WsError } from "@inkstone/ui-sdk";
import { Effect, Fiber, Stream } from "effect";
import type { WsRuntime } from "../runtime.js";
import {
	appendUserMessage,
	applyEvent,
	attachRun,
	beginRunSubscription,
	clearProposal,
	getChatState,
	getRunThreadId,
	isRunParked,
	markMessageIncomplete,
	nextMessageId,
	seedAssistantMessage,
	setHydrationStatus,
	setPendingProposal,
	setProposalStatus,
} from "./chat.js";

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

/** A first-message send also surfaces the minted thread id so its React caller can navigate to `/thread/<id>` (ADR-0042). */
export type NewThreadResult =
	| { ok: true; threadId: string }
	| { ok: false; error: unknown };

/** Optimistically seed a turn into `threadId` (completed user + live assistant), returning the seeded assistant id. */
function seedTurn(threadId: string, text: string): string {
	// The user message is its single `text` segment (ADR-0045: segments is the sole
	// source; there is no flat `text` field). The assistant opens with an empty
	// timeline the live `text_delta`/`tool_call` builders then fill.
	appendUserMessage(threadId, {
		id: nextMessageId(),
		role: "user",
		status: "completed",
		run_id: "",
		segments: [{ kind: "text", text }],
	});
	const assistantId = nextMessageId();
	seedAssistantMessage(threadId, {
		id: assistantId,
		role: "assistant",
		status: "streaming",
		run_id: "",
		segments: [],
	});
	return assistantId;
}

/** Fork the SDK stream for `runId` and drive each event into the store; the fiber is retained until its terminal event. */
export function startRunStream(
	runtime: WsRuntime,
	threadId: string,
	runId: RunId,
): void {
	// Materialize the Run as `running` and arm its snapshot bit (ADR-0022): the
	// single begin-subscribe verb behind both a fresh send and a post-decide
	// resume, so the next text_delta SETs rather than APPENDs.
	beginRunSubscription(threadId, runId);
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
	// Mark hydrated so the hydrate-on-focus effect does not re-hydrate a thread we're actively sending into (slice 13 guard).
	setHydrationStatus(threadId, "ready");
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

/**
 * First-message path: mint a thread via `threadCreate`, then seed + stream like
 * {@link send}. Returns the minted `threadId` on success so the React caller can
 * `navigate({ to: "/thread/$threadId" })` — focus is the URL, not a store field
 * (ADR-0042). The thread is pre-marked `ready` so the post-navigate remount does
 * not re-hydrate over the optimistic seed. See docs/design/web-store.md.
 */
export async function sendNewThread(
	runtime: WsRuntime,
	text: string,
): Promise<NewThreadResult> {
	const create = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.threadCreate(text);
	});

	try {
		const { thread_id, run_id } = await runtime.runPromise(create);
		// Mark hydrated so navigating onto a freshly-minted thread does NOT trigger a thread/get hydrate (slice 13 guard).
		setHydrationStatus(thread_id, "ready");
		const assistantId = seedTurn(thread_id, text);
		attachRun(thread_id, assistantId, run_id);
		startRunStream(runtime, thread_id, run_id);
		return { ok: true, threadId: thread_id };
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

/**
 * Stop a Run from the chat surface (ADR-0014). Fires `run/cancel`, then settles
 * the UI off the authoritative response: interrupt the subscribe fiber, apply a
 * synthetic `cancelled` event to settle the bubble, and drop any pending Proposal.
 *
 * We settle here for every (outcome, state) EXCEPT the one case whose terminal is
 * owned elsewhere — `already_terminal` on a *running* Run, where the live subscribe
 * stream already delivered (or will deliver) the real `done`/`error`/`cancelled`.
 * `accepted` settles (Core committed the cancel; for a running Run its real
 * `cancelled` is idempotent with the synthetic one). `unknown_run` settles (Core has
 * no run/hub, so NO stream event will ever come — bailing would leak the fiber). A
 * *parked* Run (awaiting a Proposal decision) has no live tail, so it settles on any
 * outcome rather than wedge the Stop control. See docs/design/web-store.md.
 */
export async function cancelRun(
	runtime: WsRuntime,
	runId: RunId,
): Promise<void> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.cancelRun(runId);
	});

	let outcome: "accepted" | "already_terminal" | "unknown_run";
	try {
		outcome = (await runtime.runPromise(program)).outcome;
	} catch {
		// Cancel is best-effort; a failed request leaves the Run as-is.
		return;
	}

	const threadId = getRunThreadId(runId);
	if (threadId === undefined) {
		return;
	}

	// Parked-ness is a record field read, not re-derived from Proposal status: the
	// record stays `parked` from the moment a Proposal attaches through `deciding`
	// and a failed decide, flipping back to `running` only when the resume stream
	// re-subscribes (which then owns the terminal). A racing cancel during deciding
	// clears the Proposal here, and decideProposal's currency guard then bails.
	const parked = isRunParked(runId);

	// The ONLY outcome whose terminal is owned elsewhere is `already_terminal` on a
	// non-parked Run: its live subscribe stream already delivered (or will deliver)
	// the real done/error/cancelled, which settles the bubble and reaps the fiber.
	// Every other case must settle here: `accepted` (Core committed the cancel),
	// and `unknown_run` (Core has no run/hub, so NO stream event will ever come —
	// bailing would leak the fiber and wedge Stop forever). `parked` always settles
	// since a parked Run has no live tail regardless of outcome.
	if (outcome === "already_terminal" && !parked) {
		return;
	}

	// Interrupt first so the fiber's takeUntil can't race a real terminal event,
	// then settle deterministically off the authoritative cancel response.
	interruptRun(runtime, runId);
	applyEvent(threadId, runId, { kind: "cancelled" });
	clearProposal(runId);
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
						resolved_plan: p.resolved_plan,
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

/** Decide a parked Run's Proposal (accept/reject/edit) and re-subscribe for the
 * resume tail — see docs/design/web-store.md (ADR-0025). `decisions` carries the
 * per-node vector for an `apply_intent_graph` commit (ADR-0042); the single-entity
 * kinds leave it undefined and use the scalar `decision` (+ `edited_payload`). */
export async function decideProposal(
	runtime: WsRuntime,
	runId: RunId,
	decision: "accept" | "reject" | "edit",
	editedPayload?: unknown,
	decisions?: readonly NodeDecision[],
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
			...(decisions !== undefined ? { decisions } : {}),
		});
	});

	try {
		const result = await runtime.runPromise(program);
		// Currency guard: a concurrent cancelRun (the composer Stop button stays
		// clickable while deciding) may have settled + cleared this Proposal while
		// the decide was in flight. If so the Run is terminal — don't re-fork a
		// resume stream for a cancelled Run (it would re-subscribe a dead Run and
		// its snapshot text_delta would overwrite the settled bubble).
		if (getChatState().proposals[runId] === undefined) {
			return;
		}
		setProposalStatus(runId, result.status);
		const threadId = getRunThreadId(runId);
		if (threadId !== undefined) {
			// Stale-fiber guard (M2): interrupt the parked fiber, then re-subscribe.
			// startRunStream re-arms the record's snapshot bit, so the resume's first
			// text_delta SETs (not appends) — the M1 fix; see docs/design/web-store.md.
			interruptRun(runtime, runId);
			startRunStream(runtime, threadId, runId);
		}
	} catch {
		setProposalStatus(runId, "error");
	}
}
