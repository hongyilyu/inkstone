import {
	Deferred,
	Effect,
	Either,
	Fiber,
	Layer,
	Runtime,
	Stream,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsConn } from "ws";
import {
	type ConnectionStatus,
	clearNotificationHandler,
	requestDescriptors,
	resetNotificationHandlers,
	setNotificationHandler,
	WsClient,
	WsClientConfig,
	WsClientLive,
	type WsError,
} from "../src/index.js";

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
	// The notification-handler registry is module-global state; clear it between
	// cases so a registered handler never leaks into another test.
	afterEach(() => {
		resetNotificationHandlers();
	});

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

	it("observationQuery(params) sends observation/query and round-trips ObservationQueryResult", async () => {
		const expected = {
			observations: [
				{
					id: "01999999-0000-7000-8000-000000000050",
					schema_key: "bodyweight",
					schema_version: 1,
					occurred_at: "2026-06-10T07:00:00",
					ended_at: null,
					values: { kg: 72.4 },
					note: null,
					source: null,
					created_at: 1717200000000,
					updated_at: 1717200000000,
				},
				{
					id: "01999999-0000-7000-8000-000000000051",
					schema_key: "habit.checkin",
					schema_version: 1,
					occurred_at: "2026-06-10T08:00:00",
					ended_at: null,
					values: { done: true },
					note: "morning run",
					source: null,
					created_at: 1717200001000,
					updated_at: 1717200001000,
				},
			],
		};

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "observation/query") {
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
			return yield* client.observationQuery({ schema_keys: ["bodyweight"] });
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
			expect(observed?.method).toBe("observation/query");
			expect(observed?.params).toEqual({ schema_keys: ["bodyweight"] });
		} finally {
			await server.close();
		}
	});

	it("observationUpdate(params) sends observation/update and round-trips ObservationUpdateResult", async () => {
		const expected = { observation_id: "01999999-0000-7000-8000-000000000050" };
		const params = {
			observation_id: "01999999-0000-7000-8000-000000000050",
			observation: {
				occurred_at: "2026-06-10T07:00:00",
				ended_at: "2026-06-10T07:30:00",
				values: { kg: 71.8 },
				note: "corrected",
			},
		};
		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "observation/update") {
				observed = req;
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
			}
		});
		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.observationUpdate(params);
		});
		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
			expect(observed?.method).toBe("observation/update");
			expect(observed?.params).toEqual(params); // verbatim — proves { ...params } spread, no mangling
		} finally {
			await server.close();
		}
	});

	it("getBacklinks(entityId) sends entity/backlinks with { entity_id } and round-trips EntityBacklinksResult", async () => {
		const expected = {
			mentioned_in: [
				{
					id: "01999999-0000-7000-8000-000000000040",
					type: "journal_entry",
					data: { title: "standup", body: "talked to alice" },
					created_at: 1717200000000,
					updated_at: 1717200000000,
				},
			],
			linked_todos: [
				{
					id: "01999999-0000-7000-8000-000000000041",
					type: "todo",
					data: { title: "follow up", done: false },
					created_at: 1717200001000,
					updated_at: 1717200001000,
				},
			],
		};

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "entity/backlinks") {
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
			return yield* client.getBacklinks("p_1");
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
			expect(observed?.method).toBe("entity/backlinks");
			expect(observed?.params).toEqual({ entity_id: "p_1" });
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
					segments: [{ kind: "text", text: "hi" }],
				},
				{
					id: "msg-2",
					role: "assistant",
					status: "complete",
					run_id: "01234567-89ab-7def-8012-345678901234",
					// The assistant turn's ordered segments[] (ADR-0045): tool rows, then
					// the reply text — covers the text + tool_call (with/without arg) variants.
					segments: [
						{
							kind: "tool_call",
							name: "search_entities",
							status: "completed",
							arg: "Lev",
						},
						{ kind: "tool_call", name: "read_thread", status: "completed" },
						{ kind: "text", text: "echo: hi" },
					],
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

	it("routes a registered notification method to its handler", async () => {
		const threadId = "01999999-0000-7000-8000-000000000001";
		const title = "Buying milk and other errands";

		// On a benign request the server pushes an unsolicited (id-less)
		// thread/titled notification frame.
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { threads: [] },
					}),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "thread/titled",
						params: { thread_id: threadId, title },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// A Deferred completed by the registered handler; the program awaits it
			// so the assertion runs only after the pushed frame is dispatched. The
			// handler is invoked synchronously from onFrame (off-fiber), so complete
			// the Deferred through the program's own runtime.
			const received = yield* Deferred.make<unknown>();
			const runtime = yield* Effect.runtime();
			setNotificationHandler("thread/titled", (params) => {
				Runtime.runFork(runtime)(Deferred.succeed(received, params));
			});
			// Trigger the push.
			yield* client.threadList();
			return yield* Deferred.await(received);
		});

		try {
			const params = await Effect.runPromise(provide(server.url)(program));
			expect(params).toEqual({ thread_id: threadId, title });
		} finally {
			await server.close();
		}
	});

	it("drops an unregistered notification method silently", async () => {
		const expected = {
			threads: [
				{
					id: "01999999-0000-7000-8000-000000000001",
					title: "First thread",
					last_activity_at: 1717200000000,
				},
			],
		};

		// The server pushes an unhandled notification, then answers a later
		// request — proving the unknown frame neither threw nor tore down the loop.
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "thread/titled",
						params: { thread_id: "whatever", title: "no handler" },
					}),
				);
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// No setNotificationHandler call: "thread/titled" is unregistered.
			return yield* client.threadList();
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("a throwing notification handler does not tear down the socket", async () => {
		const expected = {
			threads: [
				{
					id: "01999999-0000-7000-8000-000000000001",
					title: "First thread",
					last_activity_at: 1717200000000,
				},
			],
		};

		// The first thread/list answer is followed by an unsolicited thread/titled
		// notification whose registered handler throws; the server then answers a
		// SECOND thread/list. If the throw escaped onFrame it would kill the
		// receive loop and the follow-up request would never resolve.
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "thread/titled",
						params: {
							thread_id: "01999999-0000-7000-8000-000000000001",
							title: "boom title",
						},
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			setNotificationHandler("thread/titled", () => {
				throw new Error("boom");
			});
			// First request triggers the push that fires the throwing handler.
			yield* client.threadList();
			// A subsequent request must still resolve — proves onFrame's try/catch
			// contained the throw and the receive loop kept running.
			return yield* client.threadList();
		});

		try {
			const after = await Effect.runPromise(provide(server.url)(program));
			expect(after).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("clearNotificationHandler removes only its method — siblings still dispatch", async () => {
		// Register two methods, clear ONE, then push both frames. Only the
		// surviving method's handler must fire — proving teardown is method-scoped,
		// not clear-all (a mutation reverting to resetNotificationHandlers fails this).
		const titled: unknown[] = [];
		const other: unknown[] = [];

		// Push both notifications once, on the FIRST thread/list only; a SECOND
		// thread/list is a flush barrier — frames ahead of its response are all
		// processed by the time it resolves (single-socket frame order).
		let pushed = false;
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { threads: [] },
					}),
				);
				if (!pushed) {
					pushed = true;
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "thread/titled",
							params: { thread_id: "t1", title: "x" },
						}),
					);
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "other/event",
							params: { v: 1 },
						}),
					);
				}
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			setNotificationHandler("thread/titled", (p) => titled.push(p));
			setNotificationHandler("other/event", (p) => other.push(p));
			// Dispose only "thread/titled" — "other/event" must keep dispatching.
			clearNotificationHandler("thread/titled");
			yield* client.threadList(); // triggers both pushes
			yield* client.threadList(); // flush barrier
		});

		try {
			await Effect.runPromise(provide(server.url)(program));
			expect(titled).toEqual([]); // cleared method: handler gone
			expect(other).toEqual([{ v: 1 }]); // sibling survives and dispatched
		} finally {
			await server.close();
		}
	});

	// --- Socket-liveness signal (ADR-0051) ---

	// A server that CLOSES the first `dropFirstN` connections immediately on open,
	// then accepts and answers thread/list. The supervised reconnect loop runs
	// independently of any request, so closing on open drives consecutive drops
	// (and the status transitions) without an in-flight request to ride. After the
	// drops are exhausted the socket stays open and answers normally.
	const makeFlakyServer = async (
		dropFirstN: number,
	): Promise<{ url: string; close: () => Promise<void> }> => {
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await new Promise<void>((resolve) =>
			wss.once("listening", () => resolve()),
		);
		const { port } = wss.address() as { port: number };
		let opened = 0;
		wss.on("connection", (ws) => {
			opened += 1;
			if (opened <= dropFirstN) {
				// Drop this connection at once — the client's retry re-opens a fresh one.
				ws.close();
				return;
			}
			ws.on("message", (data) => {
				const req = JSON.parse(data.toString()) as WireRequest;
				if (req.method === "thread/list") {
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: req.id,
							result: { threads: [] },
						}),
					);
				}
			});
		});
		return {
			url: `ws://127.0.0.1:${port}/ws`,
			close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
		};
	};

	// A controllable outage harness: starts a listener (so first-open succeeds and
	// the layer builds), then `down()` terminates the live socket AND stops
	// listening — every reconnect attempt is then REFUSED (no `onOpen`, so the
	// attempt counter climbs and the ramp lapses to `disconnected`) — and `up()`
	// rebinds a fresh listener on the SAME port so the client's retry heals back to
	// `connected`. This models a real Core outage (ADR-0007: a killable local
	// process). `down()` must terminate the established socket: `wss.close()` alone
	// waits for live clients to disconnect and would hang while the client is still
	// connected.
	const makeOutageServer = async (): Promise<{
		url: string;
		down: () => Promise<void>;
		up: () => Promise<void>;
		close: () => Promise<void>;
	}> => {
		let live: WsConn[] = [];
		let wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		wss.on("connection", (ws) => live.push(ws));
		await new Promise<void>((resolve) =>
			wss.once("listening", () => resolve()),
		);
		const { port } = wss.address() as { port: number };
		return {
			url: `ws://127.0.0.1:${port}/ws`,
			down: () =>
				new Promise<void>((resolve) => {
					for (const ws of live) ws.terminate();
					live = [];
					wss.close(() => resolve());
				}),
			up: async () => {
				wss = new WebSocketServer({ port, host: "127.0.0.1" });
				wss.on("connection", (ws) => live.push(ws));
				await new Promise<void>((resolve) =>
					wss.once("listening", () => resolve()),
				);
			},
			close: () =>
				new Promise<void>((resolve) => {
					for (const ws of live) ws.terminate();
					wss.close(() => resolve());
				}),
		};
	};

	it("connectionStatus replays the current value (connected) on a late subscribe", async () => {
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list") {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: req.id,
						result: { threads: [] },
					}),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// Round-trip first so the socket is fully open and the `connected`
			// transition has already fired BEFORE we subscribe. A Queue-backed stream
			// would now yield nothing; `SubscriptionRef.changes` must replay `connected`.
			yield* client.threadList();
			return yield* client
				.connectionStatus()
				.pipe(Stream.take(1), Stream.runCollect);
		});

		try {
			const first = Array.from(
				await Effect.runPromise(provide(server.url)(program)),
			);
			expect(first).toEqual(["connected"]);
		} finally {
			await server.close();
		}
	});

	it("connectionStatus: connected → reconnecting → connected across a single drop within the fast ramp", async () => {
		// One drop on open → within the ramp → `reconnecting`; the next open heals
		// back to `connected`. The reconnect loop runs independently of any request,
		// so the status stream alone drives the sequence (sub-second on the ~50ms ramp).
		const server = await makeFlakyServer(1);

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// `Stream.changes` collapses consecutive duplicate sets (a ramp retry can
			// re-set `reconnecting`); the distinct sequence is the assertion.
			const collected = yield* Stream.runCollect(
				client.connectionStatus().pipe(Stream.changes, Stream.take(3)),
			);
			return Array.from(collected);
		});

		try {
			const statuses = await Effect.runPromise(provide(server.url)(program));
			expect(statuses).toEqual(["connected", "reconnecting", "connected"]);
		} finally {
			await server.close();
		}
	});

	it("connectionStatus settles to disconnected once the fast ramp lapses, then heals — and proves reconnect is unbounded (recovers past the old 5-attempt cap)", async () => {
		// A true outage: the listener goes DOWN, so every reconnect attempt is
		// refused (no `onOpen`). Attempts 1–5 ride the fast ramp (`reconnecting`);
		// once the ramp lapses (> RECONNECT_RAMP_ATTEMPTS = 5) the status flips to
		// `disconnected` and the retry continues on the steady interval. Bringing the
		// listener back UP heals to `connected`. Under the retired `times: 5` cap the
		// supervised fiber would have died after attempt 5 and never re-opened; that
		// the link reaches `connected` again proves the cap is gone (unbounded).
		const server = await makeOutageServer();

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			// `Stream.changes` collapses consecutive duplicate statuses: each fast-ramp
			// retry sets `reconnecting` afresh and SubscriptionRef.changes re-emits per
			// set, so without this `take(4)` would stop inside the ramp. Distinct
			// transitions: connected → reconnecting → disconnected → connected.
			const collected = yield* Effect.fork(
				Stream.runCollect(
					client.connectionStatus().pipe(Stream.changes, Stream.take(4)),
				),
			);
			// Take the listener down: the live socket drops and reconnects are refused.
			yield* Effect.promise(() => server.down());
			// Hold the outage past the fast-ramp boundary into the steady phase so the
			// status has settled to `disconnected` before the listener returns. The
			// ramp (5 attempts at the ~50ms exponential) lapses well under 2.5s.
			yield* Effect.sleep("2500 millis");
			yield* Effect.promise(() => server.up());
			const result = yield* Fiber.join(collected);
			return Array.from(result);
		});

		try {
			const statuses = await Effect.runPromise(provide(server.url)(program));
			expect(statuses).toEqual([
				"connected",
				"reconnecting",
				"disconnected",
				"connected",
			]);
		} finally {
			await server.close();
		}
	}, 30_000);

	it("the SECOND outage in a session ramps fresh — a brief blip after a long outage recovers on the fast ramp, not stuck at the steady interval", async () => {
		// Single-source-of-truth regression (ADR-0051): label and delay must BOTH be
		// derived from the per-outage attempt count, so the Nth outage behaves like
		// the first. The buggy stateless composed `Schedule` advanced its driver
		// MONOTONICALLY over the Layer lifetime (its state only resets on a SUCCESS,
		// but `connection` always fails to drive retry). So after the first outage
		// pushed the driver into its steady phase, a fresh blip — though correctly
		// LABELED `reconnecting` (the counter reset in `onOpen`) — would STALL the
		// full steady interval (5s) before retrying. This test forces a long first
		// outage (crossing the ramp into the steady phase), heals, then a brief
		// SECOND drop, and asserts the second recovery lands on the fast ramp
		// (sub-second), well under the steady interval. Against the pre-fix code the
		// second recovery waits ~5s, failing the timing assertion.
		const server = await makeOutageServer();

		// Record each distinct status transition with its wall-clock time so we can
		// assert the SECOND `reconnecting → connected` heal is fast (ramp), not slow
		// (steady). `Stream.changes` collapses the per-retry `reconnecting` re-sets.
		const seen: Array<{ status: ConnectionStatus; t: number }> = [];

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			const collector = yield* Effect.fork(
				Stream.runForEach(
					client.connectionStatus().pipe(Stream.changes, Stream.take(6)),
					(status) =>
						Effect.sync(() => {
							seen.push({ status, t: Date.now() });
						}),
				),
			);
			// --- First outage: the one slow (~2.5s) leg. Hold past the ramp into the
			// steady phase so the status settles to `disconnected` (and, pre-fix, the
			// schedule driver is now stuck in steady).
			yield* Effect.promise(() => server.down());
			yield* Effect.sleep("2500 millis");
			yield* Effect.promise(() => server.up());
			// Wait for the heal to `connected` to register before the second drop, so
			// the two outages don't blur into one transition.
			yield* client.connectionStatus().pipe(
				Stream.filter((s) => s === "connected"),
				Stream.take(1),
				Stream.runDrain,
			);
			// --- Second outage: a BRIEF blip. Down, then bring the listener back up
			// immediately so the client's next reconnect attempt finds it live. With a
			// fresh ramp (counter reset in `onOpen`) attempt 1 fires ~50ms after the
			// drop → fast heal. Pre-fix, the steady-phase driver waits ~5s.
			const secondDropAt = Date.now();
			yield* Effect.promise(() => server.down());
			yield* Effect.promise(() => server.up());
			yield* Fiber.join(collector);
			return secondDropAt;
		});

		try {
			const secondDropAt = await Effect.runPromise(
				provide(server.url)(program),
			);

			// The distinct sequence: two full outage cycles, the second on the ramp
			// (no `disconnected` — it heals before the ramp lapses).
			expect(seen.map((s) => s.status)).toEqual([
				"connected",
				"reconnecting",
				"disconnected",
				"connected",
				"reconnecting",
				"connected",
			]);

			// The SECOND heal must land on the fast ramp: the final `connected` arrives
			// well under the steady interval (5s) after the second drop. Pre-fix the
			// monotonic driver stalls ~5s here, blowing this bound.
			const secondConnectedAt = seen[5].t;
			expect(secondConnectedAt - secondDropAt).toBeLessThan(1500);
		} finally {
			await server.close();
		}
	}, 30_000);

	it("threadArchive frames thread/archive and decodes ThreadMutateResult", async () => {
		const expected = { thread_id: "t-1" };

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/archive") {
				observed = req;
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.threadArchive("t-1");
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(observed?.method).toBe("thread/archive");
			expect(observed?.params).toEqual({ thread_id: "t-1" });
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});

	it("threadListArchived frames thread/list_archived and decodes ThreadListResult", async () => {
		const expected = {
			threads: [
				{
					id: "01999999-0000-7000-8000-000000000002",
					title: "Archived thread",
					last_activity_at: 1717200000000,
				},
			],
		};

		let observed: WireRequest | undefined;
		const server = await makeServer((ws, req) => {
			if (req.method === "thread/list_archived") {
				observed = req;
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: expected }),
				);
			}
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			return yield* client.threadListArchived();
		});

		try {
			const result = await Effect.runPromise(provide(server.url)(program));
			expect(observed?.method).toBe("thread/list_archived");
			expect(observed?.params).toEqual({});
			expect(result).toEqual(expected);
		} finally {
			await server.close();
		}
	});
});

// ─── descriptor-table round-trip (one row = one covered verb) ───────────────
//
// Proves the ONE `requestDescriptors` table drives the live path for every
// request/response verb: for each row, invoke the verb with canned args
// against the fake server, assert the wire frame carries the row's `method`
// and `toParams(...)` output, and that the canned response decodes through the
// row's `result` schema (and `map`, when present). A new table row is
// automatically covered — a row missing from `cannedCases` fails the
// completeness assertion below.

// `method` and `params` are authored INDEPENDENTLY of the descriptor table
// (not derived from `d.method` / `d.toParams`): the assertion below compares the
// observed wire frame against THESE literals, so a wrong table row — misspelled
// method, mangled params — fails the round-trip instead of matching itself.
type CannedCase = {
	readonly args: readonly unknown[];
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly response: unknown;
	readonly expected?: unknown;
};

const cannedCases: Record<keyof typeof requestDescriptors, CannedCase> = {
	threadCreate: {
		args: ["hi"],
		method: "thread/create",
		params: { prompt: "hi" },
		response: { thread_id: "t-1", run_id: "r-1" },
	},
	postMessage: {
		args: ["t-1", "hello"],
		method: "run/post_message",
		params: { thread_id: "t-1", prompt: "hello" },
		response: { run_id: "r-2" },
		// postMessage is the one mapped verb: the decoded result collapses to run_id.
		expected: "r-2",
	},
	threadList: {
		args: [],
		method: "thread/list",
		params: {},
		response: { threads: [{ id: "t-1", title: "T", last_activity_at: 1 }] },
	},
	getRunHistory: {
		args: [2],
		method: "run/get_history",
		params: { limit: 2 },
		response: {
			runs: [
				{ run_id: "r-1", thread_id: "t-1", title: "T", kind: "done", at: 5 },
			],
		},
	},
	recurrencePreview: {
		args: [{ recurrence: { freq: "daily" }, due_at: "2026-01-01" }],
		method: "recurrence/preview",
		params: { recurrence: { freq: "daily" }, due_at: "2026-01-01" },
		response: { ended: false, due_at: "2026-01-02" },
	},
	threadGet: {
		args: ["t-1"],
		method: "thread/get",
		params: { thread_id: "t-1" },
		response: { thread_id: "t-1", title: "T", messages: [] },
	},
	threadRename: {
		args: ["t-1", "New"],
		method: "thread/rename",
		params: { thread_id: "t-1", title: "New" },
		response: { thread_id: "t-1" },
	},
	threadArchive: {
		args: ["t-1"],
		method: "thread/archive",
		params: { thread_id: "t-1" },
		response: { thread_id: "t-1" },
	},
	threadUnarchive: {
		args: ["t-1"],
		method: "thread/unarchive",
		params: { thread_id: "t-1" },
		response: { thread_id: "t-1" },
	},
	threadListArchived: {
		args: [],
		method: "thread/list_archived",
		params: {},
		response: { threads: [] },
	},
	listEntities: {
		args: ["todo"],
		method: "entity/list",
		params: { type: "todo" },
		response: { entities: [] },
	},
	getBacklinks: {
		args: ["e-1"],
		method: "entity/backlinks",
		params: { entity_id: "e-1" },
		response: { mentioned_in: [], linked_todos: [] },
	},
	observationQuery: {
		args: [{ schema_key: "mood" }],
		method: "observation/query",
		params: { schema_key: "mood" },
		response: { observations: [] },
	},
	observationUpdate: {
		args: [
			{
				observation_id: "o-1",
				draft: { values: {} },
			},
		],
		method: "observation/update",
		params: { observation_id: "o-1", draft: { values: {} } },
		response: { observation_id: "o-1" },
	},
	entityMutate: {
		args: [{ mutation_kind: "create_todo", payload: { title: "x" } }],
		method: "entity/mutate",
		params: { mutation_kind: "create_todo", payload: { title: "x" } },
		response: { entity_id: "e-1" },
	},
	rescanJournalEntry: {
		args: ["je-1"],
		method: "journal_entry/rescan",
		params: { je_id: "je-1" },
		response: { run_id: "r-3", thread_id: "t-2" },
	},
	messageSearch: {
		args: ["hello"],
		method: "message/search",
		params: { query: "hello" },
		response: { hits: [] },
	},
	// Discriminating literals (already_terminal vs not_errored — each decodes
	// ONLY under its own schema) so a swapped cancel/retry table row fails the
	// decode here rather than passing on the shared "accepted" value.
	cancelRun: {
		args: ["r-1"],
		method: "run/cancel",
		params: { run_id: "r-1" },
		response: { outcome: "already_terminal" },
	},
	retryRun: {
		args: ["r-1"],
		method: "run/retry",
		params: { run_id: "r-1" },
		response: { outcome: "not_errored" },
	},
	providerStatus: {
		args: [],
		method: "provider/status",
		params: {},
		response: {
			providers: [{ id: "codex", connected: true, auth_kind: "oauth" }],
		},
	},
	providerLoginStart: {
		args: ["codex"],
		method: "provider/login_start",
		params: { provider: "codex" },
		response: { authorize_url: "https://example.test/auth" },
	},
	providerConfigure: {
		args: ["openrouter", "sk-x"],
		method: "provider/configure",
		params: { provider: "openrouter", api_key: "sk-x" },
		response: {
			providers: [{ id: "openrouter", connected: true, auth_kind: "api_key" }],
		},
	},
	providerTest: {
		args: ["codex", "gpt-x"],
		method: "provider/test",
		params: { provider: "codex", model: "gpt-x" },
		response: { alive: true },
	},
	modelCatalog: {
		args: [],
		method: "model/catalog",
		params: {},
		response: {
			providers: [
				{
					id: "codex",
					label: "Codex",
					models: [{ id: "m", name: "M", reasoning: true, input: ["text"] }],
				},
			],
		},
	},
	settingsGet: {
		args: [],
		method: "settings/get",
		params: {},
		response: {
			provider: "codex",
			model: null,
			effort: "medium",
			enabled_models: [],
		},
	},
	settingsSet: {
		args: [{ model: "m", effort: "high" }],
		method: "settings/set",
		params: { model: "m", effort: "high" },
		response: {
			provider: "codex",
			model: "m",
			effort: "high",
			enabled_models: [],
		},
	},
	proposalGet: {
		args: ["r-1"],
		method: "proposal/get",
		params: { run_id: "r-1" },
		response: {
			proposal_id: "p-1",
			run_id: "r-1",
			mutation_kind: "create_todo",
			payload: { title: "x" },
			rationale: null,
			status: "pending",
		},
	},
	proposalDecide: {
		args: [{ proposal_id: "p-1", decision: "accept" }],
		method: "proposal/decide",
		params: { proposal_id: "p-1", decision: "accept" },
		response: { status: "accepted", entity_id: "e-1" },
	},
};

describe("requestDescriptors round-trip", () => {
	it("covers every table row", () => {
		expect(Object.keys(cannedCases).sort()).toEqual(
			Object.keys(requestDescriptors).sort(),
		);
	});

	for (const key of Object.keys(
		requestDescriptors,
	) as (keyof typeof requestDescriptors)[]) {
		const c = cannedCases[key];

		it(`${key} sends ${c.method} with the expected params and decodes the canned result`, async () => {
			let observed: WireRequest | undefined;
			const server = await makeServer((ws, req) => {
				observed = req;
				ws.send(
					JSON.stringify({ jsonrpc: "2.0", id: req.id, result: c.response }),
				);
			});

			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				const verb = client[key] as (
					...args: unknown[]
				) => Effect.Effect<unknown, WsError>;
				return yield* verb(...c.args);
			});

			try {
				const result = await Effect.runPromise(provide(server.url)(program));
				// Compare against the INDEPENDENTLY-authored c.method/c.params, not
				// d.method/d.toParams — a wrong table row must fail, not self-match.
				expect(observed?.method).toBe(c.method);
				expect(observed?.params).toEqual(c.params);
				expect(result).toEqual(c.expected ?? c.response);
			} finally {
				await server.close();
			}
		});
	}
});
