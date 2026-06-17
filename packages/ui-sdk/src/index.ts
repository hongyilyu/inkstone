import { Socket } from "@effect/platform";
import {
	EntityListResult,
	type EntityMutateParams,
	EntityMutateResult,
	MessageSearchResult,
	ModelCatalogResult,
	PostMessageResult,
	ProposalChangedNotification,
	type ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderLoginStartResult,
	ProviderStatusResult,
	RunCancelResult,
	type RunEvent,
	RunEvent as RunEventSchema,
	RunHistoryResult,
	SettingsResult,
	ThreadCreateResult,
	ThreadGetResult,
	ThreadListResult,
} from "@inkstone/protocol";
import {
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Either,
	Fiber,
	Layer,
	Queue,
	Runtime,
	Schema as S,
	Schedule,
	Stream,
} from "effect";

export type RunId = string;

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
		readonly threadGet: (
			threadId: string,
		) => Effect.Effect<ThreadGetResult, WsError>;
		readonly listEntities: (
			type: string,
		) => Effect.Effect<EntityListResult, WsError>;
		readonly entityMutate: (
			params: EntityMutateParams,
		) => Effect.Effect<EntityMutateResult, WsError>;
		readonly messageSearch: (
			query: string,
		) => Effect.Effect<MessageSearchResult, WsError>;
		readonly subscribeRun: (
			runId: RunId,
		) => Stream.Stream<RunEventValue, WsError>;
		readonly cancelRun: (
			runId: RunId,
		) => Effect.Effect<RunCancelResult, WsError>;
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
			const firstOpen = yield* Deferred.make<void>();
			const onOpen = Effect.sync(() => {
				hasOpened = true;
			}).pipe(
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

			// On drop: fail in-flight, then bounded-retry; `while: hasOpened` skips
			// retry on a first-open failure so the layer build can die — see docs/design/ui-sdk.md
			const supervised = connection.pipe(
				Effect.tapError(() => failPending),
				Effect.retry({
					schedule: Schedule.exponential("50 millis"),
					times: 5,
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

			const threadGet = (
				threadId: string,
			): Effect.Effect<ThreadGetResult, WsError> =>
				request("thread/get", { thread_id: threadId }, ThreadGetResult);

			// entity/list (ADR-0004): accepted Entities of one type (e.g. journal_entry, todo).
			const listEntities = (
				type: string,
			): Effect.Effect<EntityListResult, WsError> =>
				request("entity/list", { type }, EntityListResult);

			// entity/mutate (ADR-0033): a user-initiated CRUD request — same
			// {mutation_kind, payload} envelope as the Worker's propose tool.
			const entityMutate = (
				params: EntityMutateParams,
			): Effect.Effect<EntityMutateResult, WsError> =>
				request("entity/mutate", { ...params }, EntityMutateResult);

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

			return WsClient.of({
				threadCreate,
				postMessage,
				threadList,
				getRunHistory,
				threadGet,
				listEntities,
				entityMutate,
				messageSearch,
				subscribeRun,
				cancelRun,
				providerStatus,
				providerLoginStart,
				modelCatalog,
				settingsGet,
				settingsSet,
				proposalGet,
				proposalDecide,
				proposalNotifications,
			});
		}),
	);
