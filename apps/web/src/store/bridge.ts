import {
	type NodeDecision,
	type ThreadGetResult,
	type ThreadListResult,
	ThreadTitledNotification,
} from "@inkstone/protocol";
import {
	onNotification,
	type RunId,
	WsClient,
	type WsError,
} from "@inkstone/ui-sdk";
import type { QueryClient } from "@tanstack/react-query";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { taggedErrorMessage } from "../lib/taggedErrorMessage.js";
import type { WsRuntime } from "../runtime.js";
import {
	appendMessage,
	applyEvent,
	attachRun,
	beginRunSubscription,
	clearProposal,
	getChatState,
	getRunThreadId,
	isRunParked,
	markMessageIncomplete,
	nextMessageId,
	resetMessageForRetry,
	type Segment,
	setHydrationStatus,
	setPendingProposal,
	setProposalStatus,
} from "./chat.js";

// Thin imperative seam between Effect (owns wire/streams) and the plain React store — see docs/design/web-store.md (ADR-0020).
// Each run's stream fiber is retained keyed by run id so it can be interrupted on unmount (structured cancellation, Q18 A′).
const fibers = new Map<RunId, Fiber.RuntimeFiber<void, WsError>>();

// One decision_idempotency_key per proposal_id, reused across retries so Core's keyed replay recognizes a repeat (ADR-0014 retry-safety).
const decisionKeys = new Map<string, string>();

/** The global proposal-notification stream fiber, if started. */
let proposalFiber: Fiber.RuntimeFiber<void> | undefined;

/**
 * Notified once per Run when its stream reaches a terminal (done/error/cancelled,
 * including a synthetic transport-failure error). The React root registers this to
 * refresh the recent-Runs feed. It lives HERE, on the bridge's terminal seam every
 * Run flows through, NOT in a route-scoped view — so a Run that finishes while its
 * Thread is off-screen still settles the feed (a focus-keyed effect would miss it).
 */
let onRunSettled: (() => void) | undefined;

/** Register the terminal-event observer (idempotent overwrite); see {@link onRunSettled}. */
export function setOnRunSettled(fn: (() => void) | undefined): void {
	onRunSettled = fn;
}

/** Clear retained fibers — for test isolation (runtime disposal interrupts them). */
export function resetBridge(): void {
	fibers.clear();
	decisionKeys.clear();
	proposalFiber = undefined;
	onRunSettled = undefined;
}

/**
 * Patch the `["threads"]` cache in place for a `thread/titled` push (ADR-0047):
 * re-title the matching row, leave everything else verbatim. Immutable map (new
 * array, spread the matched row) so React Query's change-detection fires. Does
 * NOT touch `last_activity_at` — the title push must not reorder the sidebar.
 * A `thread_id` absent from the list matches nothing (no synthesized row); an
 * empty cache (`old` undefined) is a no-op.
 */
export function applyThreadTitled(
	queryClient: QueryClient,
	n: { thread_id: string; title: string },
): void {
	queryClient.setQueryData<ThreadListResult>(
		["threads"],
		(old) =>
			old && {
				threads: old.threads.map((t) =>
					t.id === n.thread_id ? { ...t, title: n.title } : t,
				),
			},
	);
}

/**
 * Wire the SDK's generic notification stream (ADR-0047 amendment) to the
 * `["threads"]` cache patch so the sidebar row re-titles live — no refetch. The
 * SDK decodes each `thread/titled` push through `ThreadTitledNotification` and
 * decode-drops a malformed frame, so this receives only well-formed values.
 * Returns the {@link onNotification} disposer for the `__root.tsx` unmount — it
 * interrupts ONLY this subscription's fiber, so a future run-less consumer's
 * subscription survives this one's teardown.
 */
export function registerThreadTitledHandler(
	runtime: WsRuntime,
	queryClient: QueryClient,
): () => void {
	return onNotification(
		runtime,
		"thread/titled",
		ThreadTitledNotification,
		(n) => applyThreadTitled(queryClient, n),
	);
}

/** The outcome of a send — a discriminated result so callers learn of failure off the awaited promise. */
export type SendResult = { ok: true } | { ok: false; error: unknown };

/** A first-message send also surfaces the minted thread id so its React caller can navigate to `/thread/<id>` (ADR-0061). */
export type NewThreadResult =
	| { ok: true; threadId: string }
	| { ok: false; error: unknown };

/** Optimistically seed a turn into `threadId` (completed user + live assistant), returning the seeded assistant id.
 * `attachmentSegments` (ADR-0058) follow the text segment so the user bubble shows
 * its images instantly — the media ids exist pre-send, so `/media/{id}` already resolves. */
function seedTurn(
	threadId: string,
	text: string,
	attachmentSegments: readonly Segment[] = [],
): string {
	// The user message is its single `text` segment (ADR-0045: segments is the sole
	// source; there is no flat `text` field) plus any attachment segments. The
	// assistant opens with an empty timeline the live `text_delta`/`tool_call`
	// builders then fill.
	appendMessage(threadId, {
		id: nextMessageId(),
		role: "user",
		status: "completed",
		run_id: "",
		segments: [{ kind: "text", text }, ...attachmentSegments],
	});
	const assistantId = nextMessageId();
	appendMessage(threadId, {
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
			(event) =>
				Effect.sync(() => {
					// A transport-drop injects a synthetic "error" event into the run
					// queue (ui-sdk failPending). Skip it when the Run is parked on a
					// Proposal — parking is non-terminal (ADR-0025), and the pending
					// Proposal owns the bubble; `proposal/get` rehydrates after reconnect.
					if (
						event.kind === "error" &&
						event.message.startsWith("Lost the connection") &&
						isRunParked(runId)
					) {
						return;
					}
					applyEvent(threadId, runId, event);
				}),
		);
	}).pipe(
		// A transport failure that fails the subscribe REQUEST itself (before any
		// events arrive) still needs the same treatment.
		Effect.catchAll(() =>
			Effect.sync(() => {
				if (isRunParked(runId)) return;
				applyEvent(threadId, runId, {
					kind: "error",
					message:
						"Lost the connection before this reply finished. Check that Inkstone is running, then try again.",
				});
			}),
		),
		// Identity-aware cleanup (M2): delete only when the map still points at THIS fiber — see docs/design/web-store.md.
		Effect.ensuring(
			Effect.sync(() => {
				if (fibers.get(runId) === self) {
					fibers.delete(runId);
					// The Run reached a genuine terminal (done/error/cancelled, or the
					// synthetic transport-failure above) — its recent-Runs milestone
					// changed, even if its Thread is off-screen. Refresh the feed from the
					// terminal seam (not a focus-scoped view, which misses background
					// completions). Gated by the identity check so an interrupt-then-
					// resubscribe teardown (decideProposal resume / unmount) — where the
					// map was already repointed — does NOT fire a spurious refetch.
					onRunSettled?.();
				}
			}),
		),
	);

	self = runtime.runFork(program);
	fibers.set(runId, self);
}

/** Read a File's bytes as RAW base64 — FileReader `readAsDataURL` with the
 * `data:<mime>;base64,` prefix stripped. pi-ai providers (Anthropic/Google/
 * Bedrock) corrupt on a data:-prefixed payload, so the wire carries raw base64 only. */
function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** Best-effort pixel dimensions via `createImageBitmap` (decodes a Blob directly —
 * no object-URL/Image() event juggling, and jsdom's Image never fires load/error
 * so that route hangs under test). Resolves `undefined` when the environment
 * can't decode (jsdom lacks createImageBitmap) or the bytes aren't a decodable
 * image: dimensions are a nicety on the wire (Core never sniffs, ADR-0058),
 * never an upload gate. */
async function imageDimensions(
	file: File,
): Promise<{ width: number; height: number } | undefined> {
	if (typeof createImageBitmap !== "function") {
		return undefined;
	}
	try {
		const bitmap = await createImageBitmap(file);
		const dims = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return dims;
	} catch {
		return undefined;
	}
}

/**
 * Upload `files` via `media/upload` (ADR-0058), returning the minted ids (for the
 * send's `attachment_ids`) plus the matching attachment seed segments (for the
 * optimistic user bubble) in file order. ANY single failure — a file read, the
 * upload RPC — fails the whole batch with the squashed error and uploads nothing
 * further: the caller short-circuits to `{ ok: false }` before seeding or posting.
 */
async function uploadFiles(
	runtime: WsRuntime,
	files: readonly File[],
): Promise<
	| { ok: true; ids: readonly string[]; segments: readonly Segment[] }
	| { ok: false; error: unknown }
> {
	const ids: string[] = [];
	const segments: Segment[] = [];
	for (const file of files) {
		let bytesBase64: string;
		try {
			bytesBase64 = await readAsBase64(file);
		} catch (error) {
			return { ok: false, error };
		}
		const dims = await imageDimensions(file);
		const exit = await runtime.runPromiseExit(
			Effect.flatMap(WsClient, (client) =>
				client.mediaUpload(bytesBase64, file.type, dims?.width, dims?.height),
			),
		);
		if (Exit.isFailure(exit)) {
			return { ok: false, error: Cause.squash(exit.cause) };
		}
		const mediaId = exit.value.media_id;
		ids.push(mediaId);
		segments.push({
			kind: "attachment",
			mediaId,
			mime: file.type,
			...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
		});
	}
	return { ok: true, ids, segments };
}

/** Send a prompt into a focused thread: upload any `files` (ADR-0058), seed the
 * turn, start the Run, fork its stream; a failed upload or send returns `{ ok: false }`. */
export async function send(
	runtime: WsRuntime,
	threadId: string,
	text: string,
	files?: readonly File[],
): Promise<SendResult> {
	// Upload attachments BEFORE the optimistic seed so a failed upload
	// short-circuits with nothing seeded — no orphaned bubble to unwind.
	const uploaded = await uploadFiles(runtime, files ?? []);
	if (!uploaded.ok) {
		return { ok: false, error: uploaded.error };
	}

	// Mark hydrated so the hydrate-on-focus effect does not re-hydrate a thread we're actively sending into (slice 13 guard).
	setHydrationStatus(threadId, "ready");
	const assistantId = seedTurn(threadId, text, uploaded.segments);

	const post = Effect.gen(function* () {
		const client = yield* WsClient;
		// Arity-split so a plain text send keeps its two-arg frame (the SDK also
		// omits an empty list, but never even reaching the third param is clearer).
		return yield* uploaded.ids.length
			? client.postMessage(threadId, text, uploaded.ids)
			: client.postMessage(threadId, text);
	});

	// Run via `runPromiseExit` + `Cause.squash` (mirrors useEntityMutation/
	// useRescanJournalEntry): `runPromise` would reject with Effect's `FiberFailure`
	// WRAPPER, whose generic message hides the head `WsRequestError` — so a caller
	// reading `error.reason` gets `undefined`. Squashing returns the real `WsError`,
	// which ChatColumn parses to pick the connection-specific send-failure copy
	// (ADR-0051: the per-send copy is error-driven, not ambient).
	const exit = await runtime.runPromiseExit(post);
	if (Exit.isSuccess(exit)) {
		const runId = exit.value;
		attachRun(threadId, assistantId, runId);
		startRunStream(runtime, threadId, runId);
		return { ok: true };
	}
	// postMessage failed: mark the seeded assistant message incomplete and surface
	// the squashed WsError (its `reason` drives the failure copy).
	markMessageIncomplete(threadId, assistantId);
	return { ok: false, error: Cause.squash(exit.cause) };
}

/**
 * First-message path: mint a thread via `threadCreate`, then seed + stream like
 * {@link send}. Returns the minted `threadId` on success so the React caller can
 * `navigate({ to: "/thread/$threadId" })` — focus is the URL, not a store field
 * (ADR-0061). The thread is pre-marked `ready` so the post-navigate remount does
 * not re-hydrate over the optimistic seed. See docs/design/web-store.md.
 */
export async function sendNewThread(
	runtime: WsRuntime,
	text: string,
	files?: readonly File[],
): Promise<NewThreadResult> {
	// Upload attachments BEFORE thread/create (ADR-0058): a failed upload
	// short-circuits with no thread minted, mirroring {@link send}'s seed order.
	const uploaded = await uploadFiles(runtime, files ?? []);
	if (!uploaded.ok) {
		return { ok: false, error: uploaded.error };
	}

	const create = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* uploaded.ids.length
			? client.threadCreate(text, uploaded.ids)
			: client.threadCreate(text);
	});

	// `runPromiseExit` + `Cause.squash` so the failure carries the real `WsError`,
	// not Effect's `FiberFailure` wrapper — same rationale as {@link send}.
	const exit = await runtime.runPromiseExit(create);
	if (Exit.isSuccess(exit)) {
		const { thread_id, run_id } = exit.value;
		// Mark hydrated so navigating onto a freshly-minted thread does NOT trigger a thread/get hydrate (slice 13 guard).
		setHydrationStatus(thread_id, "ready");
		const assistantId = seedTurn(thread_id, text, uploaded.segments);
		attachRun(thread_id, assistantId, run_id);
		startRunStream(runtime, thread_id, run_id);
		return { ok: true, threadId: thread_id };
	}
	// threadCreate failed before any thread was minted — nothing seeded, no orphaned bubble. Surface the squashed failure.
	return { ok: false, error: Cause.squash(exit.cause) };
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
	const program = Effect.flatMap(WsClient, (client) => client.cancelRun(runId));

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
	// A cancel settles the Run HERE, not via the stream finalizer (which we just
	// interrupted — its onRunSettled is gated off precisely so resume/unmount
	// teardowns don't fire it). So refresh the recent-Runs feed from this
	// authoritative settle point, else a user-stopped Run lingers as Running/Waiting.
	onRunSettled?.();
}

/**
 * Re-drive an errored Run IN PLACE from the chat surface (ADR-0028 retry
 * amendment, #230). Fires `run/retry`, then on `accepted` re-streams the SAME
 * `runId` — it does NOT `seedTurn` a second user/assistant turn (the #230 bug the
 * client-side re-send produced).
 *
 * `threadId` is passed explicitly rather than read via `getRunThreadId(runId)`:
 * a reloaded errored Run has no live {@link RunRecord} (hydration does not
 * materialize one), so the index would be empty — but ChatColumn always knows the
 * focused thread. On `accepted`: reset the errored assistant bubble back to
 * `streaming` (clear `error`/`incomplete`/`cancelled`, clear segments), then
 * `startRunStream` on the same `runId` — which internally `beginRunSubscription`s
 * (re-arming the cumulative-snapshot bit) and forks the subscribe tail, so the
 * first retry `text_delta` SETs the new text over the cleared timeline.
 *
 * `not_errored`/`unknown_run` are benign no-ops: the bubble already shows its
 * terminal state (a non-errored Run can't be retried), so both return `{ ok: true }`.
 * A failed REQUEST (transport/decode) returns `{ ok: false, error }` carrying the
 * squashed {@link WsError} — so the caller can surface the SAME connection-failure
 * copy `resend` does, instead of the retry button being a silent no-op (CodeRabbit
 * #244). Uses `runPromiseExit` + `Cause.squash` for the real `WsError`, mirroring
 * {@link send}.
 */
export async function retryRun(
	runtime: WsRuntime,
	threadId: string,
	runId: RunId,
): Promise<SendResult> {
	const program = Effect.flatMap(WsClient, (client) => client.retryRun(runId));

	const exit = await runtime.runPromiseExit(program);
	if (Exit.isFailure(exit)) {
		// The retry request itself failed (link down, decode) — surface the squashed
		// WsError so the caller shows the connection-specific copy, like a failed send.
		return { ok: false, error: Cause.squash(exit.cause) };
	}

	if (exit.value.outcome !== "accepted") {
		// not_errored / unknown_run: nothing to re-drive — the bubble keeps its
		// terminal state (Core did not flip the Run). Not a failure.
		return { ok: true };
	}

	// Reset the errored bubble to live, then re-stream the SAME run. startRunStream
	// arms the snapshot bit + forks the subscribe tail, so don't double-arm here.
	// Stale-fiber guard (M2), mirroring decideProposal's resume: interrupt any fiber
	// still tracked for this runId BEFORE re-subscribing, so a double-click — or an
	// errored fiber still winding down — can't leave two subscription fibers racing on
	// the same runId (whose snapshot text_deltas would fight over the bubble).
	// `interruptRun` is a no-op when no live fiber exists.
	resetMessageForRetry(threadId, runId);
	interruptRun(runtime, runId);
	startRunStream(runtime, threadId, runId);
	return { ok: true };
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
					// Parking is a Run milestone the feed reflects (Running → Waiting).
					// Refresh the recent-Runs feed so it doesn't sit on a stale "Running"
					// until the next terminal/decide (the feed refresh hook is fired for
					// any milestone the feed shows, not only terminals).
					onRunSettled?.();
				} else {
					setProposalStatus(n.run_id, n.status);
				}
				// A `proposal/get` failure must not tear down the whole stream.
			}).pipe(Effect.catchAll(() => Effect.void)),
		);
	}).pipe(Effect.ensuring(Effect.sync(() => (proposalFiber = undefined))));

	proposalFiber = runtime.runFork(program);
}

/**
 * Find the decided (accepted/rejected) outcome of exactly `proposalId` carried
 * by `runId`'s message view, if any — the durable truth the -32002 settlement
 * path reads after a `thread/get` refetch. Core emits only the run's MOST-RECENT
 * decided Proposal (a multi-park run's earlier decisions are absent), so the
 * `proposal_id` match is load-bearing: without it a stale card could settle to a
 * DIFFERENT proposal's outcome. The wire `status` is a bare string (Core filters
 * to accepted/rejected, but the type is open): any other value is skipped rather
 * than coerced, mirroring `rehydrateDecidedProposals`. `entity_id` is omitted
 * for a rejected Proposal or when no Entity resolves.
 */
function decidedProposalSegment(
	views: ThreadGetResult["messages"],
	runId: string,
	proposalId: string,
): { status: "accepted" | "rejected"; entity_id?: string } | undefined {
	for (const view of views) {
		if (view.run_id !== runId) {
			continue;
		}
		for (const seg of view.segments) {
			if (seg.kind !== "proposal" || seg.proposal_id !== proposalId) {
				continue;
			}
			const status = seg.status;
			if (status !== "accepted" && status !== "rejected") {
				continue;
			}
			return { status, entity_id: seg.entity_id };
		}
	}
	return undefined;
}

/**
 * Settle a decide that failed -32002 (ProposalNotPendingError) from durable
 * truth: ONE `thread/get` refetch, find THIS proposal's decided segment, and
 * flip the card to its real accepted/rejected pill instead of dead-ending in the
 * error state (the cross-tab race, ADR-0025). No decided segment for this
 * proposal_id (run-not-parked, cancelled, or a later Proposal superseded it),
 * an unknown run, or a failed refetch all fall back to today's generic error
 * state — no polling, no `proposal/get` (pending-only, itself -32002).
 */
async function settleDecidedProposal(
	runtime: WsRuntime,
	runId: RunId,
	proposalId: string,
): Promise<void> {
	const fallback = () => setProposalStatus(runId, "error");
	const threadId = getRunThreadId(runId);
	if (threadId === undefined) {
		fallback();
		return;
	}
	const program = Effect.flatMap(WsClient, (client) =>
		client.threadGet(threadId),
	);
	const exit = await runtime.runPromiseExit(program);
	// Currency guard: while the refetch was in flight, a concurrent cancelRun may
	// have cleared this Proposal, or the resumed Run may have re-parked on a NEW
	// one (a fresh pending card we must not overwrite) — settle only if the map
	// still holds the proposal we decided (cf. decideProposal's guard).
	if (getChatState().proposals[runId]?.proposal_id !== proposalId) {
		return;
	}
	if (Exit.isFailure(exit)) {
		fallback();
		return;
	}
	const seg = decidedProposalSegment(exit.value.messages, runId, proposalId);
	if (seg === undefined) {
		fallback();
		return;
	}
	setProposalStatus(runId, seg.status, seg.entity_id);
	// Mirror the success path: interrupt the parked fiber, re-subscribe the
	// resume tail (startRunStream re-arms the snapshot bit — M2/M1 discipline).
	interruptRun(runtime, runId);
	startRunStream(runtime, threadId, runId);
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

	// Mint once per proposal_id, reuse on retry — a lost-response "Try again"
	// replays the SAME key so Core's keyed replay returns the prior result
	// instead of double-applying (ADR-0014 retry-safety, ADR-0025 precedence).
	let key = decisionKeys.get(proposal.proposal_id);
	if (key === undefined) {
		key = crypto.randomUUID();
		decisionKeys.set(proposal.proposal_id, key);
	}

	const program = Effect.flatMap(WsClient, (client) =>
		client.proposalDecide({
			proposal_id: proposal.proposal_id,
			decision,
			decision_idempotency_key: key,
			...(decision === "edit" ? { edited_payload: editedPayload } : {}),
			...(decisions !== undefined ? { decisions } : {}),
		}),
	);

	const exit = await runtime.runPromiseExit(program);
	if (Exit.isFailure(exit)) {
		const error = Cause.squash(exit.cause);
		if (taggedErrorMessage(error, "ProposalNotPendingError") !== undefined) {
			// -32002: the Proposal is no longer decidable — decided in another tab,
			// or the Run advanced past parked. Settle from durable truth instead of
			// dead-ending. (A same-key replay returns Core's prior result as
			// success, so it never lands here.)
			await settleDecidedProposal(runtime, runId, proposal.proposal_id);
			return;
		}
		setProposalStatus(
			runId,
			"error",
			undefined,
			taggedErrorMessage(error, "InvalidParamsError"),
		);
		return;
	}
	const result = exit.value;
	// Currency guard: a concurrent cancelRun (the composer Stop button stays
	// clickable while deciding) may have settled + cleared this Proposal while
	// the decide was in flight. If so the Run is terminal — don't re-fork a
	// resume stream for a cancelled Run (it would re-subscribe a dead Run and
	// its snapshot text_delta would overwrite the settled bubble).
	if (getChatState().proposals[runId] === undefined) {
		return;
	}
	// Persist the created/updated `entity_id` (ADR-0044 amendment) so the decided
	// card can name + deep-link it; absent on a reject.
	setProposalStatus(runId, result.status, result.entity_id);
	const threadId = getRunThreadId(runId);
	if (threadId !== undefined) {
		// Stale-fiber guard (M2): interrupt the parked fiber, then re-subscribe.
		// startRunStream re-arms the record's snapshot bit, so the resume's first
		// text_delta SETs (not appends) — the M1 fix; see docs/design/web-store.md.
		interruptRun(runtime, runId);
		startRunStream(runtime, threadId, runId);
	}
}
