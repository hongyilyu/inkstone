import { Socket } from "@effect/platform";
import {
	EntityListResult,
	ModelCatalogResult,
	PostMessageResult,
	ProposalChangedNotification,
	type ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderLoginStartResult,
	ProviderStatusResult,
	type RunEvent,
	RunEvent as RunEventSchema,
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

// --- Typed errors (ADR-0020): request-level failures live in the E channel.
// Open-failure at Layer construction stays a defect (Effect.die) — see below.
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

// --- Wire envelope schema (replaces the JSON.parse(...) as {…} cast).
// A frame is one of: response-with-result | response-with-error | notification.
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

// The consumer-facing shape the UI subscribes to: a tagged union over the two
// proposal Notifications Core pushes onto a Run's subscribers (ADR-0025).
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
		readonly threadGet: (
			threadId: string,
		) => Effect.Effect<ThreadGetResult, WsError>;
		readonly listTodos: () => Effect.Effect<EntityListResult, WsError>;
		readonly subscribeRun: (
			runId: RunId,
		) => Stream.Stream<RunEventValue, WsError>;
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
			// One shared queue for proposal/* notifications (ADR-0025); the UI
			// reads them via `proposalNotifications()`. Lazily created so a Client
			// that never subscribes pays nothing.
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

			// Decode + dispatch a single inbound frame — identical to the previous
			// addEventListener("message") body. Responses resolve `pending`
			// Deferreds; run/event notifications offer onto per-run queues.
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

			// Build the Socket on @effect/platform. makeWebSocket only constructs
			// the Socket value; the connection is established when `runRaw` runs.
			// Provide the WebSocketConstructor (browser/global WebSocket — present
			// in Node 26 and the browser) internally so the public layer signature
			// stays Layer<WsClient, never, WsClientConfig> (no R leak).
			const socket = yield* Socket.makeWebSocket(cfg.url).pipe(
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
			);

			// The writer is a function (chunk) => Effect<void, SocketError>; it
			// blocks on an internal latch until the socket is open, so sends issued
			// during a reconnect window wait for the fresh connection.
			const write = yield* socket.writer;

			const decoder = new TextDecoder();

			// Fail every in-flight request with a typed connection_lost error and
			// clear the map. No resubscribe-replay: runQueues persist (a future
			// re-subscribe reuses the queue) but we do NOT auto-resend run/subscribe
			// — stream recovery is slice-13 hydration's job.
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

			// Open failure stays a defect (ADR-0020): the layer cannot construct.
			// We track the first successful open; only AFTER it has opened once do
			// we treat a disconnect as recoverable and bounded-retry.
			let hasOpened = false;
			const firstOpen = yield* Deferred.make<void>();
			const onOpen = Effect.sync(() => {
				hasOpened = true;
			}).pipe(
				Effect.zipRight(Deferred.succeed(firstOpen, void 0)),
				Effect.asVoid,
			);

			// One connection lifetime. runRaw resolves only when the link ends
			// (clean close => success; read/open/abnormal close => failure). Either
			// way the connection is gone, so we fail it uniformly to drive retry.
			const connection = socket
				.runRaw(
					(data) =>
						onFrame(typeof data === "string" ? data : decoder.decode(data)),
					{ onOpen },
				)
				.pipe(Effect.zipRight(Effect.fail("dropped" as const)));

			// On every drop, fail in-flight requests, then bounded-retry the
			// reconnect. `while: hasOpened` ensures a FIRST-open failure is NOT
			// retried (it propagates so the layer build can die); only mid-session
			// drops reconnect. Capped at 5 attempts with exponential backoff.
			const supervised = connection.pipe(
				Effect.tapError(() => failPending),
				Effect.retry({
					schedule: Schedule.exponential("50 millis"),
					times: 5,
					while: () => hasOpened,
				}),
			);

			// Fork the receive/reconnect loop into the layer scope (interrupted on
			// teardown, which closes the underlying socket — resource-safe).
			const fiber = yield* Effect.forkScoped(supervised);

			// Block layer construction until the first open succeeds. If the loop
			// ends before that (first open failed), the layer cannot construct:
			// die, matching the previous Effect.die-on-open behavior.
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

			const threadGet = (
				threadId: string,
			): Effect.Effect<ThreadGetResult, WsError> =>
				request("thread/get", { thread_id: threadId }, ThreadGetResult);

			// entity/* (ADR-0004): the live read the Library's Todos collection
			// consumes. No params (read path); returns the accepted Todos.
			const listTodos = (): Effect.Effect<EntityListResult, WsError> =>
				request("entity/list_todos", {}, EntityListResult);

			// subscribeRun is request-driven (pure-subscribe): send run/subscribe,
			// await its correlated response, THEN stream the run's events from the
			// per-run queue. The queue is created before the request is sent so any
			// run/event notifications that arrive after the ack are captured.
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

			// provider/* (ADR-0023): connection status + begin OAuth login.
			const providerStatus = (): Effect.Effect<ProviderStatusResult, WsError> =>
				request("provider/status", {}, ProviderStatusResult);

			const providerLoginStart = (
				provider: string,
			): Effect.Effect<ProviderLoginStartResult, WsError> =>
				request("provider/login_start", { provider }, ProviderLoginStartResult);

			// model/catalog + settings/* (ADR-0024): the model catalog and the
			// user's preferred model + global effort.
			const modelCatalog = (): Effect.Effect<ModelCatalogResult, WsError> =>
				request("model/catalog", {}, ModelCatalogResult);

			const settingsGet = (): Effect.Effect<SettingsResult, WsError> =>
				request("settings/get", {}, SettingsResult);

			const settingsSet = (params: {
				readonly model?: string;
				readonly effort?: string;
			}): Effect.Effect<SettingsResult, WsError> =>
				request("settings/set", { ...params }, SettingsResult);

			// proposal/* (ADR-0025): fetch a parked Run's pending Proposal and
			// decide it. `proposalNotifications` streams the pushed
			// pending/changed notifications a subscribed Client receives.
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
				threadGet,
				listTodos,
				subscribeRun,
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
