import { Socket } from "@effect/platform";
import {
	EntityBacklinksResult,
	EntityListResult,
	type EntityMutateParams,
	EntityMutateResult,
	JournalEntryRescanResult,
	MessageSearchResult,
	ModelCatalogResult,
	type ObservationQueryParams,
	ObservationQueryResult,
	PostMessageResult,
	ProposalChangedNotification,
	type ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderLoginStartResult,
	ProviderStatusResult,
	type RecurrencePreviewParams,
	RecurrencePreviewResult,
	RunCancelResult,
	type RunEvent,
	RunEvent as RunEventSchema,
	RunHistoryResult,
	RunRetryResult,
	SettingsResult,
	ThreadCreateResult,
	ThreadGetResult,
	ThreadListResult,
	ThreadMutateResult,
} from "@inkstone/protocol";
import {
	Cause,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Either,
	Fiber,
	Layer,
	Queue,
	Runtime,
	Schema as S,
	Schedule,
	Stream,
	SubscriptionRef,
} from "effect";

export type RunId = string;

/**
 * Socket-liveness signal (ADR-0051), derived purely from the client's own
 * socket lifecycle — NOT `provider/connected` (ADR-0049, OAuth state):
 * - `connected`     — socket open (or healed back open after a drop).
 * - `reconnecting`  — a post-open drop is in the fast-ramp retry window (a blip).
 * - `disconnected`  — the fast ramp lapsed; still retrying forever at the steady
 *                     interval ("down a while, retrying in the background").
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// Two-phase reconnect cadence (ADR-0051, amends ADR-0020's bounded `times: 5`):
// the first RECONNECT_RAMP_ATTEMPTS drops retry on the ~50ms exponential ramp
// (the `reconnecting` window — laptop sleep / Core restart), then a STEADY
// interval FOREVER (the `disconnected` window). A short blip never leaves
// `reconnecting`; a long outage settles to `disconnected` while still retrying,
// so recovery is automatic with no page reload.
const RECONNECT_RAMP_ATTEMPTS = 5;
const RECONNECT_STEADY_INTERVAL = "5 seconds";

// Single source of truth (ADR-0051): the per-outage attempt count drives BOTH
// the status label AND the retry delay, so they can never disagree. For the
// Nth consecutive drop since the last open: while N is within the fast ramp the
// delay is the ~50ms exponential step (`50ms * 2^(N-1)`), matching the
// `reconnecting` label; once N passes the ramp the delay is the STEADY interval,
// matching `disconnected`. Because the counter resets to 0 in `onOpen`, a fresh
// outage after a reopen ramps from 50ms again — so the second outage in a
// session behaves identically to the first (NOT stuck in the steady phase, the
// bug a stateless composed `Schedule` produced: its driver only resets on the
// retried effect SUCCEEDING, but `connection` always fails to drive retry).
const reconnectDelay = (attempt: number): Duration.DurationInput =>
	attempt > RECONNECT_RAMP_ATTEMPTS
		? RECONNECT_STEADY_INTERVAL
		: Duration.millis(50 * 2 ** (attempt - 1));

export type RunEventValue = S.Schema.Type<typeof RunEvent>;

/** Request-level WS failure (ADR-0020: lives in the E channel). */
export class WsRequestError extends Data.TaggedError("WsRequestError")<{
	reason: string;
	code?: number;
	cause?: unknown;
}> {}

export class UnknownThreadError extends Data.TaggedError("UnknownThreadError")<{
	message: string;
}> {}

export class InvalidParamsError extends Data.TaggedError("InvalidParamsError")<{
	message: string;
}> {}

export type WsError = WsRequestError | UnknownThreadError | InvalidParamsError;

// Wire frame: response-with-result | response-with-error | notification.
const WireError = S.Struct({ code: S.Number, message: S.String });

const ResponseError = S.Struct({ id: S.Number, error: WireError });
const ResponseResult = S.Struct({ id: S.Number, result: S.Unknown });
const Notification = S.Struct({ method: S.String, params: S.Unknown });
// ResponseError is first: an error frame has no `result`, but `S.Unknown`
// accepts a missing property, so ResponseResult would otherwise match it.
const Envelope = S.Union(ResponseError, ResponseResult, Notification);
const decodeEnvelope = S.decodeUnknownEither(Envelope);

const RunEventNotification = S.Struct({
	run_id: S.String,
	event: RunEventSchema,
});
const decodeRunEventNotification = S.decodeUnknownEither(RunEventNotification);

const decodeProposalPending = S.decodeUnknownEither(
	ProposalPendingNotification,
);
const decodeProposalChanged = S.decodeUnknownEither(
	ProposalChangedNotification,
);

/** Tagged union the UI subscribes to over Core's proposal notifications (ADR-0025). */
export type ProposalNotification =
	| {
			readonly kind: "pending";
			readonly run_id: string;
			readonly proposal_id: string;
	  }
	| {
			readonly kind: "changed";
			readonly run_id: string;
			readonly proposal_id: string;
			readonly status: "accepted" | "rejected";
	  };

// Generic by-method inbound-notification dispatch (ADR-0047): the Client half of
// the run-less notification channel. A producer at the app edge registers a
// handler for a method string; `onFrame`'s fallthrough routes any matching
// non-`run/event`, non-`proposal/*` notification to it with raw `params`. The
// SDK stays message-agnostic — it never decodes the payload or special-cases a
// method, so a new run-less message is a registered handler, not an interface
// change. Module-global, mirroring the `proposalQueue` state below; tests must
// `resetNotificationHandlers()` between cases.
const notificationHandlers = new Map<string, (params: unknown) => void>();

/** Register (overwriting) a handler for an inbound notification `method`. */
export function setNotificationHandler(
	method: string,
	handler: (params: unknown) => void,
): void {
	notificationHandlers.set(method, handler);
}

/** Clear all registered notification handlers (test isolation). */
export function resetNotificationHandlers(): void {
	notificationHandlers.clear();
}

/**
 * Unregister one method's handler (runtime disposal). A consumer tears down only
 * its own handler — `resetNotificationHandlers` (clear-all) is for test isolation
 * and would clobber sibling methods on the method-keyed channel.
 */
export function clearNotificationHandler(method: string): void {
	notificationHandlers.delete(method);
}

// run/subscribe acknowledgement is not a pinned protocol shape; accept {} or {run_id}.
const SubscribeAck = S.Struct({ run_id: S.optional(S.String) });

const mapWireError = (error: {
	readonly code: number;
	readonly message: string;
}): WsError => {
	if (error.code === -32001) {
		return new UnknownThreadError({ message: error.message });
	}
	if (error.code === -32602) {
		return new InvalidParamsError({ message: error.message });
	}
	return new WsRequestError({ reason: error.message, code: error.code });
};

export class WsClientConfig extends Context.Tag(
	"@inkstone/ui-sdk/WsClientConfig",
)<WsClientConfig, { readonly url: string }>() {}

export class WsClient extends Context.Tag("@inkstone/ui-sdk/WsClient")<
	WsClient,
	{
		readonly threadCreate: (
			prompt: string,
		) => Effect.Effect<ThreadCreateResult, WsError>;
		readonly postMessage: (
			threadId: string,
			prompt: string,
		) => Effect.Effect<RunId, WsError>;
		readonly threadList: () => Effect.Effect<ThreadListResult, WsError>;
		readonly getRunHistory: (
			limit?: number,
		) => Effect.Effect<RunHistoryResult, WsError>;
		readonly recurrencePreview: (
			params: RecurrencePreviewParams,
		) => Effect.Effect<RecurrencePreviewResult, WsError>;
		readonly threadGet: (
			threadId: string,
		) => Effect.Effect<ThreadGetResult, WsError>;
		// thread/{rename,archive,unarchive,list_archived} (ADR-0052): the four
		// mutating/archived-list Thread verbs. The three mutators share
		// ThreadMutateResult (the affected thread_id); list_archived mirrors
		// thread/list but reads the archived set.
		readonly threadRename: (
			threadId: string,
			title: string,
		) => Effect.Effect<ThreadMutateResult, WsError>;
		readonly threadArchive: (
			threadId: string,
		) => Effect.Effect<ThreadMutateResult, WsError>;
		readonly threadUnarchive: (
			threadId: string,
		) => Effect.Effect<ThreadMutateResult, WsError>;
		readonly threadListArchived: () => Effect.Effect<ThreadListResult, WsError>;
		readonly listEntities: (
			type: string,
		) => Effect.Effect<EntityListResult, WsError>;
		readonly getBacklinks: (
			entityId: string,
		) => Effect.Effect<EntityBacklinksResult, WsError>;
		readonly observationQuery: (
			params: ObservationQueryParams,
		) => Effect.Effect<ObservationQueryResult, WsError>;
		readonly entityMutate: (
			params: EntityMutateParams,
		) => Effect.Effect<EntityMutateResult, WsError>;
		readonly rescanJournalEntry: (
			jeId: string,
		) => Effect.Effect<JournalEntryRescanResult, WsError>;
		readonly messageSearch: (
			query: string,
		) => Effect.Effect<MessageSearchResult, WsError>;
		readonly subscribeRun: (
			runId: RunId,
		) => Stream.Stream<RunEventValue, WsError>;
		readonly cancelRun: (
			runId: RunId,
		) => Effect.Effect<RunCancelResult, WsError>;
		readonly retryRun: (runId: RunId) => Effect.Effect<RunRetryResult, WsError>;
		readonly providerStatus: () => Effect.Effect<ProviderStatusResult, WsError>;
		readonly providerLoginStart: (
			provider: string,
		) => Effect.Effect<ProviderLoginStartResult, WsError>;
		readonly modelCatalog: () => Effect.Effect<ModelCatalogResult, WsError>;
		readonly settingsGet: () => Effect.Effect<SettingsResult, WsError>;
		readonly settingsSet: (params: {
			readonly model?: string;
			readonly effort?: string;
		}) => Effect.Effect<SettingsResult, WsError>;
		readonly proposalGet: (
			runId: RunId,
		) => Effect.Effect<ProposalGetResult, WsError>;
		readonly proposalDecide: (
			params: ProposalDecideParams,
		) => Effect.Effect<ProposalDecideResult, WsError>;
		readonly proposalNotifications: () => Stream.Stream<ProposalNotification>;
		// Socket-liveness state stream (ADR-0051). No error channel — a pure
		// state stream; `SubscriptionRef.changes` replays the CURRENT value on
		// subscribe (then streams changes), so an indicator mounting long after
		// boot gets the live status immediately, not just future transitions.
		readonly connectionStatus: () => Stream.Stream<ConnectionStatus>;
	}
>() {}

export const WsClientLive: Layer.Layer<WsClient, never, WsClientConfig> =
	Layer.scoped(
		WsClient,
		Effect.gen(function* () {
			const cfg = yield* WsClientConfig;
			const runtime = yield* Effect.runtime<never>();
			const runFork = Runtime.runFork(runtime);
			const runSync = Runtime.runSync(runtime);

			const pending = new Map<number, Deferred.Deferred<unknown, WsError>>();
			const runQueues = new Map<RunId, Queue.Queue<RunEventValue>>();
			// Shared, lazily-created proposal/* queue (ADR-0025) — see docs/design/ui-sdk.md
			let proposalQueue: Queue.Queue<ProposalNotification> | undefined;
			let nextId = 1;

			// Socket-liveness state (ADR-0051). Starts `connected` since the layer
			// build blocks on first open below; set at the three lifecycle points
			// (onOpen → connected, per-drop → reconnecting, ramp-lapse → disconnected).
			const statusRef =
				yield* SubscriptionRef.make<ConnectionStatus>("connected");

			const ensureProposalQueue = (): Queue.Queue<ProposalNotification> => {
				if (proposalQueue === undefined) {
					proposalQueue = runSync(Queue.unbounded<ProposalNotification>());
				}
				return proposalQueue;
			};

			const ensureQueue = (runId: RunId): Queue.Queue<RunEventValue> => {
				let queue = runQueues.get(runId);
				if (queue === undefined) {
					queue = runSync(Queue.unbounded<RunEventValue>());
					runQueues.set(runId, queue);
				}
				return queue;
			};

			// Decode + dispatch one inbound frame: responses resolve `pending`
			// Deferreds; notifications offer onto per-run/proposal queues.
			const onFrame = (raw: string): void => {
				const decoded = decodeEnvelope(JSON.parse(raw));
				if (Either.isLeft(decoded)) {
					return;
				}
				const frame = decoded.right;
				if ("id" in frame) {
					const deferred = pending.get(frame.id);
					if (deferred === undefined) {
						return;
					}
					pending.delete(frame.id);
					if ("error" in frame) {
						runFork(Deferred.fail(deferred, mapWireError(frame.error)));
					} else {
						runFork(Deferred.succeed(deferred, frame.result));
					}
					return;
				}
				if (frame.method === "run/event") {
					const event = decodeRunEventNotification(frame.params);
					if (Either.isRight(event)) {
						const queue = ensureQueue(event.right.run_id);
						Queue.unsafeOffer(queue, event.right.event);
					}
					return;
				}
				if (frame.method === "proposal/pending") {
					const n = decodeProposalPending(frame.params);
					if (Either.isRight(n)) {
						Queue.unsafeOffer(ensureProposalQueue(), {
							kind: "pending",
							run_id: n.right.run_id,
							proposal_id: n.right.proposal_id,
						});
					}
					return;
				}
				if (frame.method === "proposal/changed") {
					const n = decodeProposalChanged(frame.params);
					if (Either.isRight(n)) {
						Queue.unsafeOffer(ensureProposalQueue(), {
							kind: "changed",
							run_id: n.right.run_id,
							proposal_id: n.right.proposal_id,
							status: n.right.status,
						});
					}
					return;
				}
				// Generic fallthrough (ADR-0047): route any other notification to a
				// registered by-method handler with raw `params`. An unregistered
				// method stays a silent no-op (preserves the drop-unknown behavior).
				// A throwing handler is swallowed so it can't tear down the receive
				// loop — same defensive posture as the decode-guarded arms above.
				const handler = notificationHandlers.get(frame.method);
				if (handler !== undefined) {
					try {
						handler(frame.params);
					} catch {}
				}
			};

			// Constructs the Socket value (connection opens at runRaw); global
			// WebSocketConstructor provided internally to avoid an R leak — see docs/design/ui-sdk.md
			const socket = yield* Socket.makeWebSocket(cfg.url).pipe(
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
			);

			// writer blocks on an internal latch until open, so sends during a
			// reconnect window wait for the fresh connection.
			const write = yield* socket.writer;

			const decoder = new TextDecoder();

			// Fails in-flight requests with connection_lost; no resubscribe-replay — see docs/design/ui-sdk.md
			const failPending = Effect.sync(() => {
				for (const deferred of pending.values()) {
					runFork(
						Deferred.fail(
							deferred,
							new WsRequestError({ reason: "connection_lost" }),
						),
					);
				}
				pending.clear();
			});

			// First-open failure stays a defect; only post-open drops are recoverable (ADR-0020) — see docs/design/ui-sdk.md
			let hasOpened = false;
			// Consecutive failed reconnect attempts since the last open. Drives the
			// `reconnecting` → `disconnected` boundary off the ATTEMPT COUNT (not
			// wall-clock) so the transition is deterministic and tests aren't flaky
			// (ADR-0051). Reset to 0 in `onOpen` when the link heals.
			let reconnectAttempts = 0;
			const firstOpen = yield* Deferred.make<void>();
			const onOpen = Effect.sync(() => {
				hasOpened = true;
				// Drives `connected` on every (re)open, so a healed link returns to
				// `connected` automatically (ADR-0051). The drop arm resets the
				// ramp counter so the next outage starts its ramp fresh.
				reconnectAttempts = 0;
			}).pipe(
				Effect.zipRight(SubscriptionRef.set(statusRef, "connected")),
				Effect.zipRight(Deferred.succeed(firstOpen, void 0)),
				Effect.asVoid,
			);

			// One connection lifetime; failed uniformly on end (incl. clean close) to drive retry — see docs/design/ui-sdk.md
			const connection = socket
				.runRaw(
					(data) =>
						onFrame(typeof data === "string" ? data : decoder.decode(data)),
					{ onOpen },
				)
				.pipe(Effect.zipRight(Effect.fail("dropped" as const)));

			// Each drop: fail in-flight requests, then drive the liveness signal off
			// the consecutive-attempt count (ADR-0051). Within the fast ramp the link
			// is `reconnecting` (a blip); once the ramp lapses it settles to
			// `disconnected` — but keeps retrying forever, so this is "down a while,
			// still retrying," NOT a terminal give-up. The count is reset in `onOpen`.
			// The next status is computed INSIDE the sync (per drop), not captured at
			// construction, so the boundary is re-evaluated on every attempt.
			const onDrop = failPending.pipe(
				Effect.zipRight(
					Effect.sync((): ConnectionStatus => {
						reconnectAttempts += 1;
						return reconnectAttempts > RECONNECT_RAMP_ATTEMPTS
							? "disconnected"
							: "reconnecting";
					}),
				),
				Effect.flatMap((status) => SubscriptionRef.set(statusRef, status)),
			);

			// Unbounded two-phase reconnect (ADR-0051, amends ADR-0020): one source of
			// truth. `tapError` runs `onDrop` (which increments `reconnectAttempts`)
			// BEFORE the schedule computes this step's delay, so `reconnectDelay` reads
			// the SAME counter value that picked the status label — the ~50ms ramp while
			// `reconnecting`, the steady interval while `disconnected`. A bare
			// `Schedule.forever` is unbounded (`times: 5` is GONE — the fiber no longer
			// dies after a handful of drops; it re-opens whenever Core returns); the
			// counter-driven `delayed` supplies the cadence. A stateless composed
			// `Schedule` could NOT do this: its internal driver only resets when the
			// retried effect SUCCEEDS, but `connection` always fails (to drive retry),
			// so it advanced monotonically across the Layer lifetime and a fresh blip
			// after a long outage stalled at the steady interval while the reset counter
			// still showed `reconnecting`. Keying the delay off `reconnectAttempts` (reset
			// in `onOpen`) makes the Nth outage in a session ramp exactly like the first.
			// `while: hasOpened` is retained so a FIRST-open failure still propagates
			// (the layer build dies, an ADR-0020 defect); only post-open drops retry.
			const reconnectSchedule = Schedule.forever.pipe(
				Schedule.delayed(() => reconnectDelay(reconnectAttempts)),
			);
			const supervised = connection.pipe(
				Effect.tapError(() => onDrop),
				Effect.retry({
					schedule: reconnectSchedule,
					while: () => hasOpened,
				}),
			);

			// Fork the receive/reconnect loop into the layer scope (interrupted on teardown).
			const fiber = yield* Effect.forkScoped(supervised);

			// Block layer construction until first open; if the loop ends first, die.
			yield* Deferred.await(firstOpen).pipe(
				Effect.raceFirst(
					Fiber.join(fiber).pipe(
						Effect.matchCauseEffect({
							onFailure: (cause) => Effect.die(Cause.squash(cause)),
							onSuccess: () =>
								Effect.die(new Error("socket closed before opening")),
						}),
					),
				),
			);

			const request = <A, I>(
				method: string,
				params: Record<string, unknown>,
				schema: S.Schema<A, I>,
			): Effect.Effect<A, WsError> =>
				Effect.gen(function* () {
					const id = nextId++;
					const deferred = yield* Deferred.make<unknown, WsError>();
					pending.set(id, deferred);
					yield* write(
						JSON.stringify({ jsonrpc: "2.0", id, method, params }),
					).pipe(
						Effect.mapError(
							(cause) => new WsRequestError({ reason: "send_failed", cause }),
						),
					);
					const result = yield* Deferred.await(deferred);
					return yield* S.decodeUnknown(schema)(result).pipe(
						Effect.mapError(
							(cause) => new WsRequestError({ reason: "decode_failed", cause }),
						),
					);
				});

			const threadCreate = (
				prompt: string,
			): Effect.Effect<ThreadCreateResult, WsError> =>
				request("thread/create", { prompt }, ThreadCreateResult);

			const postMessage = (
				threadId: string,
				prompt: string,
			): Effect.Effect<RunId, WsError> =>
				request(
					"run/post_message",
					{ thread_id: threadId, prompt },
					PostMessageResult,
				).pipe(Effect.map((r) => r.run_id));

			const threadList = (): Effect.Effect<ThreadListResult, WsError> =>
				request("thread/list", {}, ThreadListResult);

			// run/get_history (ADR-0028 as-built): the recent-Runs feed, newest-first.
			// A `limit` is sent only when given; omitting it lets Core apply its
			// default (an undefined field serializes away to `{}`).
			const getRunHistory = (
				limit?: number,
			): Effect.Effect<RunHistoryResult, WsError> =>
				request(
					"run/get_history",
					limit === undefined ? {} : { limit },
					RunHistoryResult,
				);

			// recurrence/preview (ADR-0039 amendment, #227): preview the next
			// occurrence of a draft Recurrence Rule. Read-only — the editor sends an
			// in-progress rule + the Todo's current anchor dates and renders the
			// returned dates (or `ended`). `recurrence` rides as the opaque rule object.
			const recurrencePreview = (
				params: RecurrencePreviewParams,
			): Effect.Effect<RecurrencePreviewResult, WsError> =>
				request("recurrence/preview", { ...params }, RecurrencePreviewResult);

			const threadGet = (
				threadId: string,
			): Effect.Effect<ThreadGetResult, WsError> =>
				request("thread/get", { thread_id: threadId }, ThreadGetResult);

			// thread/rename (ADR-0052): retitle a Thread (Core rejects an
			// empty/whitespace title); acks the affected thread_id.
			const threadRename = (
				threadId: string,
				title: string,
			): Effect.Effect<ThreadMutateResult, WsError> =>
				request(
					"thread/rename",
					{ thread_id: threadId, title },
					ThreadMutateResult,
				);

			// thread/archive (ADR-0052): hide a Thread from the default sidebar list.
			const threadArchive = (
				threadId: string,
			): Effect.Effect<ThreadMutateResult, WsError> =>
				request("thread/archive", { thread_id: threadId }, ThreadMutateResult);

			// thread/unarchive (ADR-0052): restore an archived Thread to the list.
			const threadUnarchive = (
				threadId: string,
			): Effect.Effect<ThreadMutateResult, WsError> =>
				request(
					"thread/unarchive",
					{ thread_id: threadId },
					ThreadMutateResult,
				);

			// thread/list_archived (ADR-0052): the archived counterpart of
			// thread/list — same ThreadListResult shape, the archived set.
			const threadListArchived = (): Effect.Effect<ThreadListResult, WsError> =>
				request("thread/list_archived", {}, ThreadListResult);

			// entity/list (ADR-0004): accepted Entities of one type (e.g. journal_entry, todo).
			const listEntities = (
				type: string,
			): Effect.Effect<EntityListResult, WsError> =>
				request("entity/list", { type }, EntityListResult);

			// entity/backlinks (ADR-0050): the two reverse sets the detail Inspector
			// shows for one Entity — mentioned_in (Journal Entries) + linked_todos.
			const getBacklinks = (
				entityId: string,
			): Effect.Effect<EntityBacklinksResult, WsError> =>
				request(
					"entity/backlinks",
					{ entity_id: entityId },
					EntityBacklinksResult,
				);

			// observation/query (#253): read-only typed-observation fetch — an
			// all-optional filter object spread onto the wire like entityMutate.
			const observationQuery = (
				params: ObservationQueryParams,
			): Effect.Effect<ObservationQueryResult, WsError> =>
				request("observation/query", { ...params }, ObservationQueryResult);

			// entity/mutate (ADR-0033): a user-initiated CRUD request — same
			// {mutation_kind, payload} envelope as the Worker's propose tool.
			const entityMutate = (
				params: EntityMutateParams,
			): Effect.Effect<EntityMutateResult, WsError> =>
				request("entity/mutate", { ...params }, EntityMutateResult);

			// journal_entry/rescan (ADR-0042): re-scan an accepted Journal Entry for
			// mentioned-but-uncaptured entities. Core resolves the JE's origin Thread
			// and starts an agent Run there; the caller navigates to that Thread.
			const rescanJournalEntry = (
				jeId: string,
			): Effect.Effect<JournalEntryRescanResult, WsError> =>
				request(
					"journal_entry/rescan",
					{ je_id: jeId },
					JournalEntryRescanResult,
				);

			// message/search (ADR-0035): substring full-text search over completed Message text.
			const messageSearch = (
				query: string,
			): Effect.Effect<MessageSearchResult, WsError> =>
				request("message/search", { query }, MessageSearchResult);

			// Queue is created before run/subscribe is sent so post-ack events aren't dropped — see docs/design/ui-sdk.md
			const subscribeRun = (
				runId: RunId,
			): Stream.Stream<RunEventValue, WsError> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const queue = ensureQueue(runId);
						yield* request("run/subscribe", { run_id: runId }, SubscribeAck);
						return Stream.fromQueue(queue);
					}),
				);

			// run/cancel (ADR-0014): ask Core to cancel a Run. For a running Run the
			// terminal `cancelled` Run Event also arrives over subscribeRun; for a
			// parked Run nothing is pushed, so the response outcome is authoritative.
			const cancelRun = (
				runId: RunId,
			): Effect.Effect<RunCancelResult, WsError> =>
				request("run/cancel", { run_id: runId }, RunCancelResult);

			// run/retry (ADR-0028 retry amendment, #230): ask Core to re-drive an
			// errored Run IN PLACE on the same run id. `accepted` means Core won the
			// `errored → running` flip and is re-streaming (its terminal arrives over
			// subscribeRun); `not_errored`/`unknown_run` are normal response values.
			const retryRun = (runId: RunId): Effect.Effect<RunRetryResult, WsError> =>
				request("run/retry", { run_id: runId }, RunRetryResult);

			// provider/* (ADR-0023): connection status + begin OAuth login.
			const providerStatus = (): Effect.Effect<ProviderStatusResult, WsError> =>
				request("provider/status", {}, ProviderStatusResult);

			const providerLoginStart = (
				provider: string,
			): Effect.Effect<ProviderLoginStartResult, WsError> =>
				request("provider/login_start", { provider }, ProviderLoginStartResult);

			// model/catalog + settings/* (ADR-0024): catalog, preferred model, global effort.
			const modelCatalog = (): Effect.Effect<ModelCatalogResult, WsError> =>
				request("model/catalog", {}, ModelCatalogResult);

			const settingsGet = (): Effect.Effect<SettingsResult, WsError> =>
				request("settings/get", {}, SettingsResult);

			const settingsSet = (params: {
				readonly model?: string;
				readonly effort?: string;
			}): Effect.Effect<SettingsResult, WsError> =>
				request("settings/set", { ...params }, SettingsResult);

			// proposal/* (ADR-0025): get a parked Run's pending Proposal, decide it,
			// and stream the pushed pending/changed notifications.
			const proposalGet = (
				runId: RunId,
			): Effect.Effect<ProposalGetResult, WsError> =>
				request("proposal/get", { run_id: runId }, ProposalGetResult);

			const proposalDecide = (
				params: ProposalDecideParams,
			): Effect.Effect<ProposalDecideResult, WsError> =>
				request("proposal/decide", { ...params }, ProposalDecideResult);

			const proposalNotifications = (): Stream.Stream<ProposalNotification> =>
				Stream.fromQueue(ensureProposalQueue());

			// `.changes` replays the current value on subscribe, then streams every
			// transition — the property the indicator needs to render the LIVE status
			// when it mounts after boot, not "unknown" until the next drop (ADR-0051).
			const connectionStatus = (): Stream.Stream<ConnectionStatus> =>
				statusRef.changes;

			return WsClient.of({
				threadCreate,
				postMessage,
				threadList,
				getRunHistory,
				recurrencePreview,
				threadGet,
				threadRename,
				threadArchive,
				threadUnarchive,
				threadListArchived,
				listEntities,
				getBacklinks,
				observationQuery,
				entityMutate,
				rescanJournalEntry,
				messageSearch,
				subscribeRun,
				cancelRun,
				retryRun,
				providerStatus,
				providerLoginStart,
				modelCatalog,
				settingsGet,
				settingsSet,
				proposalGet,
				proposalDecide,
				proposalNotifications,
				connectionStatus,
			});
		}),
	);
