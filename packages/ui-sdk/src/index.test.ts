import { Effect, Either, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsConn } from "ws";
import { WsClient, WsClientConfig, WsClientLive } from "./index.js";

type WireRequest = {
	id?: number;
	method?: string;
	params?: { [k: string]: unknown };
};

const makeServer = async (
	onMessage: (ws: WsConn, req: WireRequest) => void,
): Promise<{ url: string; close: () => Promise<void> }> => {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
	const { port } = wss.address() as { port: number };
	wss.on("connection", (ws) => {
		ws.on("message", (data) => onMessage(ws, JSON.parse(data.toString())));
	});
	return {
		url: `ws://127.0.0.1:${port}/ws`,
		close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
	};
};

const provide =
	(url: string) =>
	<A, E>(program: Effect.Effect<A, E, WsClient>): Effect.Effect<A, E> =>
		program.pipe(
			Effect.scoped,
			Effect.provide(
				WsClientLive.pipe(
					Layer.provide(Layer.succeed(WsClientConfig, { url })),
				),
			),
		);

describe("WsClient", () => {
	it("threadCreate returns the ids and subscribeRun streams the run's events after run/subscribe", async () => {
		const threadId = "01999999-0000-7000-8000-000000000001";
		const runId = "01234567-89ab-7def-8012-345678901234";

		const server = await makeServer((ws, req) => {
			if (req.method === "thread/create") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { thread_id: threadId, run_id: runId },
					}),
				);
			}
			if (req.method === "run/subscribe") {
				const subscribedRunId = req.params?.run_id;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { run_id: subscribedRunId },
					}),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "run/event",
						params: {
							run_id: subscribedRunId,
							event: { kind: "text_delta", delta: "echo: hi" },
						},
					}),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "run/event",
						params: {
							run_id: subscribedRunId,
							event: { kind: "done" },
						},
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			const created = yield* client.threadCreate("hi");
			const events = yield* Stream.runCollect(
				client
					.subscribeRun(created.run_id)
					.pipe(Stream.takeUntil((e) => e.kind === "done")),
			);
			return { created, events: Array.from(events) };
		});

		try {
			const { created, events } = await Effect.runPromise(
				provide(server.url)(program),
			);

			expect(created).toEqual({ thread_id: threadId, run_id: runId });
			expect(events).toEqual([
				{ kind: "text_delta", delta: "echo: hi" },
				{ kind: "done" },
			]);
		} finally {
			await server.close();
		}
	});

	it("threadList round-trips the canonical ThreadListResult", async () => {
		const expected = {
			threads: [
				{
					id: "01999999-0000-7000-8000-000000000001",
					title: "First thread",
					last_activity_at: 1717200000000,
				},
			],
		};

		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: expected,
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.threadList();
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("getRunHistory(limit) sends run/get_history with { limit } and round-trips RunHistoryResult", async () => {
		const expected = {
			runs: [
				{
					run_id: "01999999-0000-7000-8000-000000000aaa",
					thread_id: "01999999-0000-7000-8000-000000000bbb",
					title: "Newest run",
					kind: "proposal_decided",
					at: 1717200002000,
				},
				{
					run_id: "01999999-0000-7000-8000-000000000ccc",
					thread_id: "01999999-0000-7000-8000-000000000ddd",
					title: "Older run",
					kind: "done",
					at: 1717200001000,
				},
			],
		};

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "run/get_history") {
				observed = req;
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.getRunHistory(25);
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(observed?.method).toBe("run/get_history");
			expect(observed?.params).toEqual({ limit: 25 });
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("getRunHistory() omits limit and rejects an out-of-domain kind", async () => {
		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "run/get_history") {
				observed = req;
				// A kind outside the 7-literal union must fail the decode.
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: {
							runs: [
								{
									run_id: "01999999-0000-7000-8000-000000000eee",
									thread_id: "01999999-0000-7000-8000-000000000fff",
									title: "Bad kind",
									kind: "teleported",
									at: 1717200003000,
								},
							],
						},
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.getRunHistory();
		}).pipe(Effect.either);

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			// No limit was passed → params is the empty object.
			expect(observed?.params).toEqual({});
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left._tag).toBe("WsRequestError");
				expect((result.left as { reason?: string }).reason).toBe(
					"decode_failed",
				);
			}
		} finally {
			await server.close();
		}
	});

	it("listEntities(type) sends entity/list with { type } and round-trips EntityListResult", async () => {
		const expected = {
			entities: [
				{
					id: "01999999-0000-7000-8000-000000000030",
					type: "todo",
					data: { title: "buy milk", done: false },
					created_at: 1717200000000,
					updated_at: 1717200000000,
				},
			],
		};

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "entity/list") {
				observed = req;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: expected,
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.listEntities("todo");
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
			expect(observed?.method).toBe("entity/list");
			expect(observed?.params).toEqual({ type: "todo" });
		} finally {
			await server.close();
		}
	});

	it("threadGet round-trips the canonical ThreadGetResult", async () => {
		const expected = {
			thread_id: "01999999-0000-7000-8000-000000000001",
			title: "First thread",
			messages: [
				{
					id: "msg-1",
					role: "user",
					status: "complete",
					run_id: "01234567-89ab-7def-8012-345678901234",
					text: "hi",
					tool_calls: [],
				},
				{
					id: "msg-2",
					role: "assistant",
					status: "complete",
					run_id: "01234567-89ab-7def-8012-345678901234",
					text: "echo: hi",
					tool_calls: [{ name: "read_thread", status: "completed" }],
				},
			],
		};

		const server = await makeServer((ws, req) => {
			if (req.method === "thread/get") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: expected,
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.threadGet(expected.thread_id);
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("postMessage sends thread_id and prompt and returns the run_id", async () => {
		const runId = "01234567-89ab-7def-8012-345678901234";
		let captured: WireRequest["params"];

		const server = await makeServer((ws, req) => {
			if (req.method === "run/post_message") {
				captured = req.params;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { run_id: runId },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.postMessage("thread-x", "hello");
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toBe(runId);
			expect(captured?.thread_id).toBe("thread-x");
			expect(captured?.prompt).toBe("hello");
		} finally {
			await server.close();
		}
	});

	it("fails in-flight requests with connection_lost on a mid-session drop, then bounded-reconnects so a fresh request succeeds", async () => {
		const expected = {
			threads: [
				{
					id: "01999999-0000-7000-8000-000000000001",
					title: "First thread",
					last_activity_at: 1717200000000,
				},
			],
		};
		let listAcks = 0;

		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				listAcks += 1;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: expected,
					}),
				);
				return;
			}
			if (req.method === "thread/get") {
				// In-flight request: drop the connection without responding. The
				// server keeps listening, so the client's bounded retry re-opens
				// a fresh connection that answers the post-reconnect request.
				ws.close();
				return;
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// First request on connection 1 succeeds.
			yield* client.threadList();
			// In-flight request that the server drops on — must fail (not hang).
			const inflight = yield* Effect.either(client.threadGet("dropped"));
			// Post-reconnect request must resolve on the fresh connection.
			const after = yield* client.threadList();
			return { inflight, after };
		});

		try {
			const { inflight, after } = await Effect.runPromise(
				provide(server.url)(program),
			);

			expect(Either.isLeft(inflight)).toBe(true);
			if (Either.isLeft(inflight)) {
				expect(inflight.left._tag).toBe("WsRequestError");
				if (inflight.left._tag === "WsRequestError") {
					expect(inflight.left.reason).toBe("connection_lost");
				}
			}
			expect(after).toEqual(expected);
			expect(listAcks).toBeGreaterThanOrEqual(2);
		} finally {
			await server.close();
		}
	});

	it("maps a -32001 error envelope to a typed failure in the E channel", async () => {
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/get") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						error: { code: -32001, message: "unknown_thread" },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.threadGet("missing");
		});

		try {
			const result = await Effect.runPromise(
				provide(server.url)(Effect.either(program)),
			);
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left._tag).toBe("UnknownThreadError");
			}
		} finally {
			await server.close();
		}
	});

	it("routes a proposal/pending notification to the proposalNotifications stream", async () => {
		const runId = "01234567-89ab-7def-8012-345678901234";
		const proposalId = "01900000-0000-7000-8000-000000000010";

		const server = await makeServer((ws, req) => {
			if (req.method === "run/subscribe") {
				const subscribedRunId = req.params?.run_id;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { run_id: subscribedRunId },
					}),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "proposal/pending",
						params: {
							run_id: subscribedRunId,
							proposal_id: proposalId,
						},
					}),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "proposal/changed",
						params: {
							run_id: subscribedRunId,
							proposal_id: proposalId,
							status: "accepted",
						},
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// Drain the run's events in the background so the run/subscribe
			// request is actually sent (the server pushes the proposal frames in
			// response). The run stream never sees a `done`, so it would block
			// forever — interrupt it once we've collected the proposals.
			const subFiber = yield* Effect.fork(
				Stream.runDrain(client.subscribeRun(runId)),
			);
			const events = yield* Stream.runCollect(
				client.proposalNotifications().pipe(Stream.take(2)),
			);
			yield* Fiber.interrupt(subFiber);
			return Array.from(events);
		});

		try {
			const events = await Effect.runPromise(provide(server.url)(program));
			expect(events).toEqual([
				{ kind: "pending", run_id: runId, proposal_id: proposalId },
				{
					kind: "changed",
					run_id: runId,
					proposal_id: proposalId,
					status: "accepted",
				},
			]);
		} finally {
			await server.close();
		}
	});

	it("proposalGet sends run_id and decodes the ProposalGetResult", async () => {
		const runId = "01234567-89ab-7def-8012-345678901234";
		const expected = {
			proposal_id: "01900000-0000-7000-8000-000000000010",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {
				occurred_at: "2026-06-10T10:30:00",
				body: [{ type: "text", text: "Bought milk." }],
			},
			rationale: "the user asked",
			status: "pending",
		};
		let captured: WireRequest["params"];

		const server = await makeServer((ws, req) => {
			if (req.method === "proposal/get") {
				captured = req.params;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: expected,
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.proposalGet(runId);
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
			expect(captured?.run_id).toBe(runId);
		} finally {
			await server.close();
		}
	});

	it("entityMutate sends entity/mutate with the mutation envelope and decodes the result", async () => {
		const entityId = "01900000-0000-7000-8000-000000000020";
		let captured: WireRequest["params"];

		const server = await makeServer((ws, req) => {
			if (req.method === "entity/mutate") {
				captured = req.params;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { entity_id: entityId },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.entityMutate({
				mutation_kind: "create_person",
				payload: { name: "A" },
			});
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual({ entity_id: entityId });
			expect(captured?.mutation_kind).toBe("create_person");
			expect(captured?.payload).toEqual({ name: "A" });
		} finally {
			await server.close();
		}
	});

	it("cancelRun sends run_id and decodes the RunCancelResult", async () => {
		const runId = "01234567-89ab-7def-8012-345678901234";
		let captured: WireRequest["params"];

		const server = await makeServer((ws, req) => {
			if (req.method === "run/cancel") {
				captured = req.params;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { outcome: "accepted" },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.cancelRun(runId);
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual({ outcome: "accepted" });
			expect(captured?.run_id).toBe(runId);
		} finally {
			await server.close();
		}
	});

	it("proposalDecide sends the decision params and decodes the result", async () => {
		const proposalId = "01900000-0000-7000-8000-000000000010";
		const entityId = "01900000-0000-7000-8000-000000000020";
		let captured: WireRequest["params"];

		const server = await makeServer((ws, req) => {
			if (req.method === "proposal/decide") {
				captured = req.params;
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { status: "accepted", entity_id: entityId },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.proposalDecide({
				proposal_id: proposalId,
				decision: "accept",
				decision_idempotency_key: "k1",
			});
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual({ status: "accepted", entity_id: entityId });
			expect(captured?.proposal_id).toBe(proposalId);
			expect(captured?.decision).toBe("accept");
			expect(captured?.decision_idempotency_key).toBe("k1");
		} finally {
			await server.close();
		}
	});
});
