import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	MessageView,
	PostMessageParams,
	PostMessageResult,
	RunEvent,
	SubscribeParams,
	ThreadCreateParams,
	ThreadCreateResult,
	ThreadGetParams,
	ThreadGetResult,
	ThreadListResult,
	ThreadSummary,
	WorkerInbound,
	WorkerOutbound,
} from "./index.js";

describe("PostMessageParams", () => {
	it("decodes a valid thread_id and prompt", () => {
		const wire = {
			thread_id: "01900000-0000-7000-8000-000000000000",
			prompt: "hi",
		};
		expect(S.decodeUnknownSync(PostMessageParams)(wire)).toEqual(wire);
	});

	it("rejects a missing thread_id", () => {
		expect(() =>
			S.decodeUnknownSync(PostMessageParams)({ prompt: "hi" }),
		).toThrow();
	});

	it("rejects a missing prompt", () => {
		expect(() =>
			S.decodeUnknownSync(PostMessageParams)({
				thread_id: "01900000-0000-7000-8000-000000000000",
			}),
		).toThrow();
	});

	it("rejects a non-string prompt", () => {
		expect(() =>
			S.decodeUnknownSync(PostMessageParams)({
				thread_id: "01900000-0000-7000-8000-000000000000",
				prompt: 42,
			}),
		).toThrow();
	});

	it("encodes back to the same snake_case wire shape", () => {
		const decoded = S.decodeUnknownSync(PostMessageParams)({
			thread_id: "01900000-0000-7000-8000-000000000000",
			prompt: "hi",
		});
		expect(S.encodeSync(PostMessageParams)(decoded)).toEqual({
			thread_id: "01900000-0000-7000-8000-000000000000",
			prompt: "hi",
		});
	});
});

describe("PostMessageResult", () => {
	it("decodes a valid run_id without renaming the wire field", () => {
		const wire = { run_id: "01900000-0000-7000-8000-000000000000" };
		expect(S.decodeUnknownSync(PostMessageResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same snake_case wire shape", () => {
		const decoded = S.decodeUnknownSync(PostMessageResult)({
			run_id: "01900000-0000-7000-8000-000000000000",
		});
		expect(S.encodeSync(PostMessageResult)(decoded)).toEqual({
			run_id: "01900000-0000-7000-8000-000000000000",
		});
	});

	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(PostMessageResult)({})).toThrow();
	});
});

describe("SubscribeParams", () => {
	it("decodes a run_id", () => {
		const wire = { run_id: "01900000-0000-7000-8000-000000000000" };
		expect(S.decodeUnknownSync(SubscribeParams)(wire)).toEqual(wire);
	});

	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(SubscribeParams)({})).toThrow();
	});
});

describe("ThreadCreateParams", () => {
	it("decodes a prompt", () => {
		expect(S.decodeUnknownSync(ThreadCreateParams)({ prompt: "hi" })).toEqual({
			prompt: "hi",
		});
	});

	it("rejects a missing prompt", () => {
		expect(() => S.decodeUnknownSync(ThreadCreateParams)({})).toThrow();
	});
});

describe("ThreadCreateResult", () => {
	it("decodes thread_id and run_id without renaming the wire fields", () => {
		const wire = {
			thread_id: "01900000-0000-7000-8000-000000000000",
			run_id: "01900000-0000-7000-8000-000000000001",
		};
		expect(S.decodeUnknownSync(ThreadCreateResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same snake_case wire shape", () => {
		const decoded = S.decodeUnknownSync(ThreadCreateResult)({
			thread_id: "01900000-0000-7000-8000-000000000000",
			run_id: "01900000-0000-7000-8000-000000000001",
		});
		expect(S.encodeSync(ThreadCreateResult)(decoded)).toEqual({
			thread_id: "01900000-0000-7000-8000-000000000000",
			run_id: "01900000-0000-7000-8000-000000000001",
		});
	});
});

describe("ThreadSummary", () => {
	it("decodes id, title, and a numeric last_activity_at", () => {
		const wire = {
			id: "01900000-0000-7000-8000-000000000000",
			title: "First thread",
			last_activity_at: 1_700_000_000_000,
		};
		expect(S.decodeUnknownSync(ThreadSummary)(wire)).toEqual(wire);
	});

	it("rejects a non-number last_activity_at", () => {
		expect(() =>
			S.decodeUnknownSync(ThreadSummary)({
				id: "01900000-0000-7000-8000-000000000000",
				title: "First thread",
				last_activity_at: "soon",
			}),
		).toThrow();
	});
});

describe("ThreadListResult", () => {
	it("decodes a threads array", () => {
		const wire = {
			threads: [
				{
					id: "01900000-0000-7000-8000-000000000000",
					title: "First thread",
					last_activity_at: 1_700_000_000_000,
				},
			],
		};
		expect(S.decodeUnknownSync(ThreadListResult)(wire)).toEqual(wire);
	});

	it("encodes back preserving last_activity_at as a number", () => {
		const decoded = S.decodeUnknownSync(ThreadListResult)({
			threads: [
				{
					id: "01900000-0000-7000-8000-000000000000",
					title: "First thread",
					last_activity_at: 1_700_000_000_000,
				},
			],
		});
		expect(S.encodeSync(ThreadListResult)(decoded)).toEqual({
			threads: [
				{
					id: "01900000-0000-7000-8000-000000000000",
					title: "First thread",
					last_activity_at: 1_700_000_000_000,
				},
			],
		});
	});
});

describe("ThreadGetParams", () => {
	it("decodes a thread_id", () => {
		const wire = { thread_id: "01900000-0000-7000-8000-000000000000" };
		expect(S.decodeUnknownSync(ThreadGetParams)(wire)).toEqual(wire);
	});

	it("rejects a missing thread_id", () => {
		expect(() => S.decodeUnknownSync(ThreadGetParams)({})).toThrow();
	});
});

describe("MessageView", () => {
	it("decodes all snake_case fields", () => {
		const wire = {
			id: "01900000-0000-7000-8000-000000000000",
			role: "assistant",
			status: "completed",
			run_id: "01900000-0000-7000-8000-000000000001",
			text: "echo: hi",
		};
		expect(S.decodeUnknownSync(MessageView)(wire)).toEqual(wire);
	});
});

describe("ThreadGetResult", () => {
	it("decodes thread header plus a messages array", () => {
		const wire = {
			thread_id: "01900000-0000-7000-8000-000000000000",
			title: "First thread",
			messages: [
				{
					id: "01900000-0000-7000-8000-000000000002",
					role: "user",
					status: "completed",
					run_id: "01900000-0000-7000-8000-000000000001",
					text: "hi",
				},
				{
					id: "01900000-0000-7000-8000-000000000003",
					role: "assistant",
					status: "streaming",
					run_id: "01900000-0000-7000-8000-000000000001",
					text: "echo: hi",
				},
			],
		};
		expect(S.decodeUnknownSync(ThreadGetResult)(wire)).toEqual(wire);
	});

	it("encodes back preserving all snake_case fields", () => {
		const wire = {
			thread_id: "01900000-0000-7000-8000-000000000000",
			title: "First thread",
			messages: [
				{
					id: "01900000-0000-7000-8000-000000000002",
					role: "user",
					status: "completed",
					run_id: "01900000-0000-7000-8000-000000000001",
					text: "hi",
				},
			],
		};
		const decoded = S.decodeUnknownSync(ThreadGetResult)(wire);
		expect(S.encodeSync(ThreadGetResult)(decoded)).toEqual(wire);
	});
});

describe("RunEvent", () => {
	it("decodes a text_delta variant", () => {
		const event = { kind: "text_delta", delta: "echo: hi" };
		expect(S.decodeUnknownSync(RunEvent)(event)).toEqual(event);
	});

	it("decodes a done variant", () => {
		expect(S.decodeUnknownSync(RunEvent)({ kind: "done" })).toEqual({
			kind: "done",
		});
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "unknown" }),
		).toThrow();
	});

	it("rejects a text_delta missing its delta field", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "text_delta" }),
		).toThrow();
	});
});

describe("WorkerInbound", () => {
	it("decodes a worker stdin frame", () => {
		expect(S.decodeUnknownSync(WorkerInbound)({ prompt: "hi" })).toEqual({
			prompt: "hi",
		});
	});

	it("rejects a missing prompt", () => {
		expect(() => S.decodeUnknownSync(WorkerInbound)({})).toThrow();
	});
});

describe("WorkerOutbound", () => {
	it("aliases RunEvent and accepts text_delta", () => {
		expect(
			S.decodeUnknownSync(WorkerOutbound)({
				kind: "text_delta",
				delta: "echo: hi",
			}),
		).toEqual({ kind: "text_delta", delta: "echo: hi" });
	});

	it("aliases RunEvent and accepts done", () => {
		expect(S.decodeUnknownSync(WorkerOutbound)({ kind: "done" })).toEqual({
			kind: "done",
		});
	});
});
