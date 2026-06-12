import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	AgentToolResult,
	CoreToolDescriptor,
	EntityListParams,
	EntityListResult,
	EntityRow,
	MessageView,
	PostMessageParams,
	PostMessageResult,
	ProposalChangedNotification,
	ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetParams,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderLoginStartParams,
	ProviderLoginStartResult,
	ProviderStatusResult,
	RunCancelParams,
	RunCancelResult,
	RunEvent,
	SubscribeParams,
	SubscribeResult,
	ThreadCreateParams,
	ThreadCreateResult,
	ThreadGetParams,
	ThreadGetResult,
	ThreadListResult,
	ThreadSummary,
	ToolRequest,
	ToolResult,
	WorkerInbound,
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

describe("SubscribeResult", () => {
	it("decodes run_id and status and encodes back unchanged", () => {
		const wire = {
			run_id: "01900000-0000-7000-8000-000000000000",
			status: "parked",
		};
		const decoded = S.decodeUnknownSync(SubscribeResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(SubscribeResult)(decoded)).toEqual(wire);
	});

	it("rejects a missing status", () => {
		expect(() =>
			S.decodeUnknownSync(SubscribeResult)({
				run_id: "01900000-0000-7000-8000-000000000000",
			}),
		).toThrow();
	});
});

describe("RunCancelParams", () => {
	it("decodes a run_id and encodes back unchanged", () => {
		const wire = { run_id: "01900000-0000-7000-8000-000000000000" };
		const decoded = S.decodeUnknownSync(RunCancelParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(RunCancelParams)(decoded)).toEqual(wire);
	});

	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(RunCancelParams)({})).toThrow();
	});
});

describe("RunCancelResult", () => {
	it("decodes each outcome and encodes back unchanged", () => {
		for (const outcome of [
			"accepted",
			"already_terminal",
			"unknown_run",
		] as const) {
			const wire = { outcome };
			const decoded = S.decodeUnknownSync(RunCancelResult)(wire);
			expect(decoded).toEqual(wire);
			expect(S.encodeSync(RunCancelResult)(decoded)).toEqual(wire);
		}
	});

	it("rejects an unknown outcome", () => {
		expect(() =>
			S.decodeUnknownSync(RunCancelResult)({ outcome: "maybe" }),
		).toThrow();
	});
});

describe("ProposalGetParams", () => {
	it("decodes a run_id and encodes back unchanged", () => {
		const wire = { run_id: "01900000-0000-7000-8000-000000000000" };
		const decoded = S.decodeUnknownSync(ProposalGetParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalGetParams)(decoded)).toEqual(wire);
	});

	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(ProposalGetParams)({})).toThrow();
	});
});

describe("ProposalGetResult", () => {
	const wire = {
		proposal_id: "01900000-0000-7000-8000-000000000010",
		run_id: "01900000-0000-7000-8000-000000000000",
		mutation_kind: "create_journal_entry",
		payload: {
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Bought milk." }],
		},
		rationale: "the user asked to remember this",
		status: "pending",
	};

	it("decodes a full proposal with opaque data and encodes back unchanged", () => {
		const decoded = S.decodeUnknownSync(ProposalGetResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(wire);
	});

	it("decodes review_context.current_journal_entry and encodes back unchanged", () => {
		const withReviewContext = {
			...wire,
			mutation_kind: "update_journal_entry",
			payload: {
				entity_id: "01900000-0000-7000-8000-000000000099",
				occurred_at: "2026-06-10T11:00:00",
				body: [{ type: "text", text: "Bought oat milk." }],
			},
			review_context: {
				current_journal_entry: {
					entity_id: "01900000-0000-7000-8000-000000000099",
					occurred_at: "2026-06-10T10:30:00",
					ended_at: "2026-06-10T10:45:00",
					body: [{ type: "text", text: "Bought milk." }],
				},
			},
		};
		const decoded = S.decodeUnknownSync(ProposalGetResult)(withReviewContext);
		expect(decoded).toEqual(withReviewContext);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(withReviewContext);
	});

	it("remains backward compatible when review_context is absent", () => {
		const decoded = S.decodeUnknownSync(ProposalGetResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(wire);
	});

	it("decodes a null rationale", () => {
		const noReason = { ...wire, rationale: null };
		expect(S.decodeUnknownSync(ProposalGetResult)(noReason)).toEqual(noReason);
	});

	it("rejects a missing status", () => {
		const { status: _omit, ...noStatus } = wire;
		expect(() => S.decodeUnknownSync(ProposalGetResult)(noStatus)).toThrow();
	});
});

describe("ProposalDecideParams", () => {
	it("decodes an accept with an idempotency key and encodes back unchanged", () => {
		const wire = {
			proposal_id: "01900000-0000-7000-8000-000000000010",
			decision: "accept",
			decision_idempotency_key: "k1",
		};
		const decoded = S.decodeUnknownSync(ProposalDecideParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalDecideParams)(decoded)).toEqual(wire);
	});

	it("decodes a bare accept (no key, no edited_payload)", () => {
		const wire = {
			proposal_id: "01900000-0000-7000-8000-000000000010",
			decision: "accept",
		};
		expect(S.decodeUnknownSync(ProposalDecideParams)(wire)).toEqual(wire);
	});

	it("decodes an edit carrying an opaque edited_payload", () => {
		const wire = {
			proposal_id: "01900000-0000-7000-8000-000000000010",
			decision: "edit",
			edited_payload: { title: "buy oat milk", done: false },
		};
		expect(S.decodeUnknownSync(ProposalDecideParams)(wire)).toEqual(wire);
	});

	it("decodes reject", () => {
		const wire = {
			proposal_id: "01900000-0000-7000-8000-000000000010",
			decision: "reject",
		};
		expect(S.decodeUnknownSync(ProposalDecideParams)(wire)).toEqual(wire);
	});

	it("rejects an unknown decision", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalDecideParams)({
				proposal_id: "01900000-0000-7000-8000-000000000010",
				decision: "defer",
			}),
		).toThrow();
	});

	it("rejects a missing proposal_id", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalDecideParams)({ decision: "accept" }),
		).toThrow();
	});
});

describe("ProposalDecideResult", () => {
	it("decodes an accepted result with an entity_id and encodes back unchanged", () => {
		const wire = {
			status: "accepted",
			entity_id: "01900000-0000-7000-8000-000000000020",
		};
		const decoded = S.decodeUnknownSync(ProposalDecideResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalDecideResult)(decoded)).toEqual(wire);
	});

	it("decodes a rejected result with no entity_id", () => {
		const wire = { status: "rejected" };
		expect(S.decodeUnknownSync(ProposalDecideResult)(wire)).toEqual(wire);
	});

	it("rejects an unknown status", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalDecideResult)({ status: "deferred" }),
		).toThrow();
	});
});

describe("ProposalPendingNotification", () => {
	it("decodes run_id and proposal_id and encodes back unchanged", () => {
		const wire = {
			run_id: "01900000-0000-7000-8000-000000000000",
			proposal_id: "01900000-0000-7000-8000-000000000010",
		};
		const decoded = S.decodeUnknownSync(ProposalPendingNotification)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalPendingNotification)(decoded)).toEqual(wire);
	});

	it("rejects a missing proposal_id", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalPendingNotification)({
				run_id: "01900000-0000-7000-8000-000000000000",
			}),
		).toThrow();
	});
});

describe("ProposalChangedNotification", () => {
	it("decodes run_id, proposal_id, and status and encodes back unchanged", () => {
		const wire = {
			run_id: "01900000-0000-7000-8000-000000000000",
			proposal_id: "01900000-0000-7000-8000-000000000010",
			status: "accepted",
		};
		const decoded = S.decodeUnknownSync(ProposalChangedNotification)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ProposalChangedNotification)(decoded)).toEqual(wire);
	});

	it("decodes a rejected status", () => {
		const wire = {
			run_id: "01900000-0000-7000-8000-000000000000",
			proposal_id: "01900000-0000-7000-8000-000000000010",
			status: "rejected",
		};
		expect(S.decodeUnknownSync(ProposalChangedNotification)(wire)).toEqual(
			wire,
		);
	});

	it("rejects an unknown status", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalChangedNotification)({
				run_id: "01900000-0000-7000-8000-000000000000",
				proposal_id: "01900000-0000-7000-8000-000000000010",
				status: "deferred",
			}),
		).toThrow();
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

describe("EntityRow", () => {
	const wire = {
		id: "01900000-0000-7000-8000-000000000030",
		type: "todo",
		data: { title: "buy milk", done: false },
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
	};

	it("decodes a row with opaque data and encodes back unchanged", () => {
		const decoded = S.decodeUnknownSync(EntityRow)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(EntityRow)(decoded)).toEqual(wire);
	});

	it("rejects a non-number created_at", () => {
		expect(() =>
			S.decodeUnknownSync(EntityRow)({ ...wire, created_at: "today" }),
		).toThrow();
	});

	it("rejects a missing type", () => {
		const { type: _omit, ...noType } = wire;
		expect(() => S.decodeUnknownSync(EntityRow)(noType)).toThrow();
	});
});

describe("EntityListResult", () => {
	it("decodes an entities array and encodes back unchanged", () => {
		const wire = {
			entities: [
				{
					id: "01900000-0000-7000-8000-000000000030",
					type: "todo",
					data: { title: "buy milk", done: false },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
			],
		};
		const decoded = S.decodeUnknownSync(EntityListResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(EntityListResult)(decoded)).toEqual(wire);
	});

	it("decodes an empty entities array", () => {
		expect(S.decodeUnknownSync(EntityListResult)({ entities: [] })).toEqual({
			entities: [],
		});
	});
});

describe("EntityListParams", () => {
	it("decodes a type and encodes back to the same wire shape", () => {
		const wire = { type: "person" };
		const decoded = S.decodeUnknownSync(EntityListParams)(wire);
		expect(decoded).toEqual(wire);
		// The Client ENCODES this param onto the wire, so guard the encode
		// mirror too (the Rust side decodes it).
		expect(S.encodeSync(EntityListParams)(decoded)).toEqual(wire);
	});

	it("rejects a missing type", () => {
		expect(() => S.decodeUnknownSync(EntityListParams)({})).toThrow();
	});

	it("rejects a non-string type", () => {
		expect(() => S.decodeUnknownSync(EntityListParams)({ type: 42 })).toThrow();
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

	it("decodes a cancelled variant", () => {
		expect(S.decodeUnknownSync(RunEvent)({ kind: "cancelled" })).toEqual({
			kind: "cancelled",
		});
	});

	it("decodes an error variant carrying a message", () => {
		const event = { kind: "error", message: "provider rejected the request" };
		expect(S.decodeUnknownSync(RunEvent)(event)).toEqual(event);
	});

	it("rejects an error variant missing its message field", () => {
		expect(() => S.decodeUnknownSync(RunEvent)({ kind: "error" })).toThrow();
	});

	it("rejects an unknown kind", () => {
		expect(() => S.decodeUnknownSync(RunEvent)({ kind: "unknown" })).toThrow();
	});

	it("rejects a text_delta missing its delta field", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "text_delta" }),
		).toThrow();
	});

	it.each([
		"started",
		"completed",
		"error",
	] as const)("decodes a tool_call variant with status %s", (status) => {
		const event = {
			kind: "tool_call",
			tool_call_id: "tc_01",
			name: "read_thread",
			status,
		};
		expect(S.decodeUnknownSync(RunEvent)(event)).toEqual(event);
	});

	it("rejects a tool_call with an unknown status", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({
				kind: "tool_call",
				tool_call_id: "tc_01",
				name: "read_thread",
				status: "pending",
			}),
		).toThrow();
	});

	it("rejects a tool_call missing its name field", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({
				kind: "tool_call",
				tool_call_id: "tc_01",
				status: "started",
			}),
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

	it("aliases RunEvent and accepts cancelled", () => {
		expect(S.decodeUnknownSync(WorkerOutbound)({ kind: "cancelled" })).toEqual({
			kind: "cancelled",
		});
	});
});

describe("ProviderStatusResult", () => {
	it("decodes a providers array with connection flags", () => {
		const wire = { providers: [{ id: "openai-codex", connected: false }] };
		expect(S.decodeUnknownSync(ProviderStatusResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same wire shape", () => {
		const decoded = S.decodeUnknownSync(ProviderStatusResult)({
			providers: [{ id: "openai-codex", connected: true }],
		});
		expect(S.encodeSync(ProviderStatusResult)(decoded)).toEqual({
			providers: [{ id: "openai-codex", connected: true }],
		});
	});

	it("rejects a non-boolean connected", () => {
		expect(() =>
			S.decodeUnknownSync(ProviderStatusResult)({
				providers: [{ id: "openai-codex", connected: "yes" }],
			}),
		).toThrow();
	});
});

describe("ProviderLoginStartResult", () => {
	it("decodes an authorize_url", () => {
		const wire = { authorize_url: "https://auth.openai.com/oauth/authorize" };
		expect(S.decodeUnknownSync(ProviderLoginStartResult)(wire)).toEqual(wire);
	});

	it("rejects a missing authorize_url", () => {
		expect(() => S.decodeUnknownSync(ProviderLoginStartResult)({})).toThrow();
	});
});

describe("ProviderLoginStartParams", () => {
	it("decodes a provider and encodes back to the same wire shape", () => {
		const wire = { provider: "openai-codex" };
		const decoded = S.decodeUnknownSync(ProviderLoginStartParams)(wire);
		expect(decoded).toEqual(wire);
		// The Client ENCODES this param onto the wire, so guard the encode
		// mirror too (the Rust side decodes it).
		expect(S.encodeSync(ProviderLoginStartParams)(decoded)).toEqual(wire);
	});

	it("rejects a missing provider", () => {
		expect(() => S.decodeUnknownSync(ProviderLoginStartParams)({})).toThrow();
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

	it("decodes a manifest whose tools carry descriptor objects", () => {
		const withTools = {
			...valid,
			workflow: {
				...valid.workflow,
				tools: [
					{
						name: "read_file",
						description: "Read a file from disk.",
						label: "Read file",
						json_schema: { type: "object", properties: {} },
					},
				],
			},
		};
		expect(S.decodeUnknownSync(WorkerManifest)(withTools)).toEqual(withTools);
	});

	it("rejects a bare-string entry in workflow.tools", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({
				...valid,
				workflow: { ...valid.workflow, tools: ["read_file"] },
			}),
		).toThrow();
	});

	it("decodes mode: resume with a typed-block resume transcript (ADR-0025)", () => {
		const resume = {
			...valid,
			mode: "resume",
			messages: [
				{ role: "user", text: "remember to buy milk" },
				{
					role: "assistant",
					tool_calls: [
						{
							id: "tc_1",
							name: "propose_workspace_mutation",
							arguments: {
								mutation_kind: "create_journal_entry",
								payload: {
									occurred_at: "2026-06-10T10:30:00",
									body: [{ type: "text", text: "Bought milk." }],
								},
							},
						},
					],
				},
				{
					role: "tool_result",
					tool_call_id: "tc_1",
					content: "Accepted. Created Journal Entry.",
				},
			],
		};
		expect(S.decodeUnknownSync(WorkerManifest)(resume)).toEqual(resume);
	});

	it("decodes mode: fresh and a tool_result carrying is_error", () => {
		const fresh = { ...valid, mode: "fresh" };
		expect(S.decodeUnknownSync(WorkerManifest)(fresh)).toEqual(fresh);

		const withError = {
			...valid,
			messages: [
				{
					role: "tool_result",
					tool_call_id: "tc_9",
					content: "boom",
					is_error: true,
				},
			],
		};
		expect(S.decodeUnknownSync(WorkerManifest)(withError)).toEqual(withError);
	});

	it("rejects an unknown mode", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({ ...valid, mode: "replay" }),
		).toThrow();
	});

	it("rejects a tool_result message missing tool_call_id", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({
				...valid,
				messages: [{ role: "tool_result", content: "x" }],
			}),
		).toThrow();
	});
});

describe("ToolTextContent / AgentToolResult", () => {
	it("decodes a content array of text blocks", () => {
		const wire = {
			content: [{ type: "text", text: "file contents" }],
		};
		expect(S.decodeUnknownSync(AgentToolResult)(wire)).toEqual(wire);
	});

	it("decodes optional details and terminate", () => {
		const wire = {
			content: [{ type: "text", text: "ok" }],
			details: { lines: 12 },
			terminate: true,
		};
		expect(S.decodeUnknownSync(AgentToolResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same wire shape", () => {
		const wire = {
			content: [{ type: "text", text: "ok" }],
			terminate: false,
		};
		const decoded = S.decodeUnknownSync(AgentToolResult)(wire);
		expect(S.encodeSync(AgentToolResult)(decoded)).toEqual(wire);
	});

	it("rejects a content block with a non-text type", () => {
		expect(() =>
			S.decodeUnknownSync(AgentToolResult)({
				content: [{ type: "image", text: "x" }],
			}),
		).toThrow();
	});

	it("rejects a missing content array", () => {
		expect(() => S.decodeUnknownSync(AgentToolResult)({})).toThrow();
	});
});

describe("ToolRequest", () => {
	const valid = {
		kind: "tool_request",
		run_id: "01900000-0000-7000-8000-000000000000",
		tool_call_id: "call_1",
		name: "read_file",
		params: { path: "/etc/hosts" },
	};

	it("decodes a valid tool_request with opaque params", () => {
		expect(S.decodeUnknownSync(ToolRequest)(valid)).toEqual(valid);
	});

	it("encodes back to the same snake_case wire shape", () => {
		const decoded = S.decodeUnknownSync(ToolRequest)(valid);
		expect(S.encodeSync(ToolRequest)(decoded)).toEqual(valid);
	});

	it("rejects a missing tool_call_id", () => {
		const { tool_call_id: _omit, ...noId } = valid;
		expect(() => S.decodeUnknownSync(ToolRequest)(noId)).toThrow();
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			S.decodeUnknownSync(ToolRequest)({ ...valid, kind: "tool_invoke" }),
		).toThrow();
	});
});

describe("ToolResult", () => {
	const ok = {
		kind: "tool_result",
		run_id: "01900000-0000-7000-8000-000000000000",
		tool_call_id: "call_1",
		outcome: { ok: { content: [{ type: "text", text: "contents" }] } },
	};
	const err = {
		kind: "tool_result",
		run_id: "01900000-0000-7000-8000-000000000000",
		tool_call_id: "call_1",
		outcome: { err: { code: "not_found", message: "no such file" } },
	};

	it("decodes an ok outcome carrying an AgentToolResult", () => {
		expect(S.decodeUnknownSync(ToolResult)(ok)).toEqual(ok);
	});

	it("decodes an err outcome carrying a code and message", () => {
		expect(S.decodeUnknownSync(ToolResult)(err)).toEqual(err);
	});

	it("encodes the ok outcome back to the same wire shape", () => {
		const decoded = S.decodeUnknownSync(ToolResult)(ok);
		expect(S.encodeSync(ToolResult)(decoded)).toEqual(ok);
	});

	it("rejects a missing tool_call_id", () => {
		const { tool_call_id: _omit, ...noId } = ok;
		expect(() => S.decodeUnknownSync(ToolResult)(noId)).toThrow();
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			S.decodeUnknownSync(ToolResult)({ ...ok, kind: "tool_response" }),
		).toThrow();
	});

	it("rejects an err outcome missing its message", () => {
		expect(() =>
			S.decodeUnknownSync(ToolResult)({
				...err,
				outcome: { err: { code: "not_found" } },
			}),
		).toThrow();
	});
});

describe("CoreToolDescriptor", () => {
	const valid = {
		name: "read_file",
		description: "Read a file from disk.",
		label: "Read file",
		json_schema: { type: "object", properties: { path: { type: "string" } } },
	};

	it("decodes a descriptor with an opaque json_schema", () => {
		expect(S.decodeUnknownSync(CoreToolDescriptor)(valid)).toEqual(valid);
	});

	it("encodes back to the same wire shape", () => {
		const decoded = S.decodeUnknownSync(CoreToolDescriptor)(valid);
		expect(S.encodeSync(CoreToolDescriptor)(decoded)).toEqual(valid);
	});

	it("rejects a missing label", () => {
		const { label: _omit, ...noLabel } = valid;
		expect(() => S.decodeUnknownSync(CoreToolDescriptor)(noLabel)).toThrow();
	});
});

describe("WorkerOutbound (RunEvent | ToolRequest)", () => {
	it("accepts a tool_request variant", () => {
		const wire = {
			kind: "tool_request",
			run_id: "01900000-0000-7000-8000-000000000000",
			tool_call_id: "call_1",
			name: "read_file",
			params: { path: "/etc/hosts" },
		};
		expect(S.decodeUnknownSync(WorkerOutbound)(wire)).toEqual(wire);
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerOutbound)({ kind: "tool_response" }),
		).toThrow();
	});
});

describe("WorkerInbound (ToolResult)", () => {
	it("aliases ToolResult and accepts an ok outcome", () => {
		const wire = {
			kind: "tool_result",
			run_id: "01900000-0000-7000-8000-000000000000",
			tool_call_id: "call_1",
			outcome: { ok: { content: [{ type: "text", text: "contents" }] } },
		};
		expect(S.decodeUnknownSync(WorkerInbound)(wire)).toEqual(wire);
	});
});
