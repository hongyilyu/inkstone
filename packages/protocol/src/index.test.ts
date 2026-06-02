import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	AuthStatusResult,
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
	WorkerManifest,
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

	it("decodes an error variant carrying a message", () => {
		const event = { kind: "error", message: "provider rejected the request" };
		expect(S.decodeUnknownSync(RunEvent)(event)).toEqual(event);
	});

	it("rejects an error variant missing its message field", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "error" }),
		).toThrow();
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

describe("AuthStatusResult", () => {
	it("decodes a providers array with connection flags", () => {
		const wire = { providers: [{ id: "openai-codex", connected: false }] };
		expect(S.decodeUnknownSync(AuthStatusResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same wire shape", () => {
		const decoded = S.decodeUnknownSync(AuthStatusResult)({
			providers: [{ id: "openai-codex", connected: true }],
		});
		expect(S.encodeSync(AuthStatusResult)(decoded)).toEqual({
			providers: [{ id: "openai-codex", connected: true }],
		});
	});

	it("rejects a non-boolean connected", () => {
		expect(() =>
			S.decodeUnknownSync(AuthStatusResult)({
				providers: [{ id: "openai-codex", connected: "yes" }],
			}),
		).toThrow();
	});
});

describe("WorkerManifest", () => {
	const valid = {
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "openai-codex",
			model: "gpt-5.5",
			system_prompt: "You assist with journaling.",
			thinking_level: "off",
			tools: [],
		},
		prompt: "hello",
		messages: [
			{ role: "user", text: "earlier question" },
			{ role: "assistant", text: "earlier answer" },
		],
		access_token: "tok_abc",
	};

	it("decodes a full manifest with history and access token", () => {
		expect(S.decodeUnknownSync(WorkerManifest)(valid)).toEqual(valid);
	});

	it("decodes a manifest without an access token (faux/env providers)", () => {
		const { access_token: _omit, ...noToken } = valid;
		expect(S.decodeUnknownSync(WorkerManifest)(noToken)).toEqual(noToken);
	});

	it("decodes an empty history and empty tools", () => {
		const minimal = { ...valid, messages: [], access_token: undefined };
		const { access_token: _o, ...expected } = minimal;
		expect(S.decodeUnknownSync(WorkerManifest)({ ...expected })).toEqual(
			expected,
		);
	});

	it("rejects an unknown thinking_level", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({
				...valid,
				workflow: { ...valid.workflow, thinking_level: "turbo" },
			}),
		).toThrow();
	});

	it("rejects a message with an unknown role", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({
				...valid,
				messages: [{ role: "system", text: "x" }],
			}),
		).toThrow();
	});
});
