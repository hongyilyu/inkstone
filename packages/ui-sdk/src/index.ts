import {
	PostMessageResult,
	type RunEvent,
	RunEvent as RunEventSchema,
	ThreadCreateResult,
	ThreadGetResult,
	ThreadListResult,
} from "@inkstone/protocol";
import {
	Context,
	Data,
	Deferred,
	Effect,
	Either,
	Layer,
	Queue,
	Runtime,
	Schema as S,
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

export class UnknownThreadError extends Data.TaggedError(
	"UnknownThreadError",
)<{ message: string }> {}

export class InvalidParamsError extends Data.TaggedError(
	"InvalidParamsError",
)<{ message: string }> {}

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
		readonly subscribeRun: (
			runId: RunId,
		) => Stream.Stream<RunEventValue, WsError>;
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

			// Open the WebSocket; the Layer is "ready" only once it's open.
			// Open failure is a defect (Effect.die) — the Layer cannot construct,
			// so it is not a recoverable request-level error.
			const socket = yield* Effect.async<WebSocket>((resume) => {
				const ws = new WebSocket(cfg.url);
				ws.addEventListener("open", () => resume(Effect.succeed(ws)), {
					once: true,
				});
				ws.addEventListener("error", (ev) => resume(Effect.die(ev)), {
					once: true,
				});
			});

			const pending = new Map<number, Deferred.Deferred<unknown, WsError>>();
			const runQueues = new Map<RunId, Queue.Queue<RunEventValue>>();
			let nextId = 1;

			const ensureQueue = (runId: RunId): Queue.Queue<RunEventValue> => {
				let queue = runQueues.get(runId);
				if (queue === undefined) {
					queue = runSync(Queue.unbounded<RunEventValue>());
					runQueues.set(runId, queue);
				}
				return queue;
			};

			socket.addEventListener("message", (ev) => {
				const decoded = decodeEnvelope(JSON.parse(String(ev.data)));
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
				}
			});

			yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

			const request = <A, I>(
				method: string,
				params: Record<string, unknown>,
				schema: S.Schema<A, I>,
			): Effect.Effect<A, WsError> =>
				Effect.gen(function* () {
					const id = nextId++;
					const deferred = yield* Deferred.make<unknown, WsError>();
					pending.set(id, deferred);
					socket.send(
						JSON.stringify({ jsonrpc: "2.0", id, method, params }),
					);
					const result = yield* Deferred.await(deferred);
					return yield* S.decodeUnknown(schema)(result).pipe(
						Effect.mapError(
							(cause) =>
								new WsRequestError({ reason: "decode_failed", cause }),
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
						yield* request(
							"run/subscribe",
							{ run_id: runId },
							SubscribeAck,
						);
						return Stream.fromQueue(queue);
					}),
				);

			return WsClient.of({
				threadCreate,
				postMessage,
				threadList,
				threadGet,
				subscribeRun,
			});
		}),
	);
