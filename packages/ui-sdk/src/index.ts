import { PostMessageResult, type RunEvent } from "@inkstone/protocol";
import {
	Context,
	Deferred,
	Effect,
	Layer,
	Queue,
	Runtime,
	Schema as S,
	Stream,
} from "effect";
import WebSocket from "ws";

export type RunId = string;

export type RunEventValue = S.Schema.Type<typeof RunEvent>;

export class WsClientConfig extends Context.Tag(
	"@inkstone/ui-sdk/WsClientConfig",
)<WsClientConfig, { readonly url: string }>() {}

export class WsClient extends Context.Tag("@inkstone/ui-sdk/WsClient")<
	WsClient,
	{
		readonly postMessage: (prompt: string) => Effect.Effect<RunId>;
		readonly subscribeRun: (runId: RunId) => Stream.Stream<RunEventValue>;
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
			const socket = yield* Effect.async<WebSocket>((resume) => {
				const ws = new WebSocket(cfg.url);
				ws.once("open", () => resume(Effect.succeed(ws)));
				ws.once("error", (err) => resume(Effect.die(err)));
			});

			const pending = new Map<number, Deferred.Deferred<unknown>>();
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

			socket.on("message", (data) => {
				const msg = JSON.parse(data.toString()) as {
					id?: number;
					method?: string;
					result?: unknown;
					params?: { run_id: RunId; event: RunEventValue };
				};
				if (msg.id !== undefined) {
					const deferred = pending.get(msg.id);
					if (deferred !== undefined) {
						pending.delete(msg.id);
						runFork(Deferred.succeed(deferred, msg.result));
					}
					return;
				}
				if (msg.method === "run/event" && msg.params !== undefined) {
					const queue = ensureQueue(msg.params.run_id);
					Queue.unsafeOffer(queue, msg.params.event);
				}
			});

			yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

			const postMessage = (prompt: string): Effect.Effect<RunId> =>
				Effect.gen(function* () {
					const id = nextId++;
					const deferred = yield* Deferred.make<unknown>();
					pending.set(id, deferred);
					socket.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "run/post_message",
							params: { prompt },
						}),
					);
					const result = yield* Deferred.await(deferred);
					return S.decodeUnknownSync(PostMessageResult)(result).run_id;
				});

			const subscribeRun = (runId: RunId): Stream.Stream<RunEventValue> =>
				Stream.fromQueue(ensureQueue(runId));

			return WsClient.of({ postMessage, subscribeRun });
		}),
	);
