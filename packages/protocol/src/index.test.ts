import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	AgentToolResult,
	CoreToolDescriptor,
	EntityListParams,
	EntityListResult,
	EntityRow,
	MessageHit,
	MessageSearchParams,
	MessageSearchResult,
	ObservationQueryParams,
	ObservationQueryResult,
	ObservationRecordParams,
	ObservationRecordResult,
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
	ThreadGetParams,
	ThreadSummary,
	ToolRequest,
	ToolResult,
	WorkerManifest,
	WorkerOutbound,
} from "./index.js";

describe("PostMessageParams", () => {
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
});

describe("PostMessageResult", () => {
	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(PostMessageResult)({})).toThrow();
	});
});

describe("SubscribeParams", () => {
	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(SubscribeParams)({})).toThrow();
	});
});

describe("SubscribeResult", () => {
	it("rejects a missing status", () => {
		expect(() =>
			S.decodeUnknownSync(SubscribeResult)({
				run_id: "01900000-0000-7000-8000-000000000000",
			}),
		).toThrow();
	});
});

describe("RunCancelParams", () => {
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
					body: [
						{ type: "text", text: "Bought " },
						{
							type: "entity_ref",
							ref_id: "01900000-0000-7000-8000-000000000111",
						},
						{ type: "text", text: "." },
					],
				},
			},
		};
		const decoded = S.decodeUnknownSync(ProposalGetResult)(withReviewContext);
		expect(decoded).toEqual(withReviewContext);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(withReviewContext);
	});

	it("decodes review_context.current_person (update_person) and encodes back unchanged", () => {
		const withCurrentPerson = {
			...wire,
			mutation_kind: "update_person",
			payload: {
				entity_id: "01900000-0000-7000-8000-000000000099",
				name: "Ada Lovelace",
			},
			review_context: {
				current_person: {
					entity_id: "01900000-0000-7000-8000-000000000099",
					name: "Ada Lovelace",
					note: "met at the analytical-engine demo",
					aliases: ["Ada", "Countess Lovelace"],
				},
			},
		};
		const decoded = S.decodeUnknownSync(ProposalGetResult)(withCurrentPerson);
		expect(decoded).toEqual(withCurrentPerson);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(withCurrentPerson);
	});

	it("decodes review_context.current_project (optional field) and round-trips", () => {
		const withCurrentProject = {
			...wire,
			mutation_kind: "update_project",
			payload: {
				entity_id: "01900000-0000-7000-8000-0000000000c1",
				name: "Lead Ads",
			},
			review_context: {
				current_project: {
					entity_id: "01900000-0000-7000-8000-0000000000c1",
					name: "Lead Ads",
					outcome: "ship the testing variant",
					status: "active",
					note: "Q3 priority",
				},
			},
		};
		const decoded = S.decodeUnknownSync(ProposalGetResult)(withCurrentProject);
		expect(decoded).toEqual(withCurrentProject);
		expect(S.encodeSync(ProposalGetResult)(decoded)).toEqual(
			withCurrentProject,
		);
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

	it("rejects a per-node decision outside accept/reject", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalDecideParams)({
				proposal_id: "01900000-0000-7000-8000-000000000010",
				decision: "accept",
				decisions: [{ handle: "@je", decision: "edit" }],
			}),
		).toThrow();
	});
});

describe("ProposalDecideResult", () => {
	it("rejects an unknown status", () => {
		expect(() =>
			S.decodeUnknownSync(ProposalDecideResult)({ status: "deferred" }),
		).toThrow();
	});
});

describe("ProposalPendingNotification", () => {
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
	it("rejects a missing prompt", () => {
		expect(() => S.decodeUnknownSync(ThreadCreateParams)({})).toThrow();
	});
});

describe("ThreadSummary", () => {
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

describe("EntityRow", () => {
	const wire = {
		id: "01900000-0000-7000-8000-000000000030",
		type: "todo",
		data: { title: "buy milk", status: "active" },
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
	};

	it("rejects a person_ref with an unknown role", () => {
		expect(() =>
			S.decodeUnknownSync(EntityRow)({
				...wire,
				person_refs: [{ person_id: "p1", role: "owner" }],
			}),
		).toThrow();
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
	it("decodes an empty entities array", () => {
		expect(S.decodeUnknownSync(EntityListResult)({ entities: [] })).toEqual({
			entities: [],
		});
	});
});

describe("EntityListParams", () => {
	it("rejects a missing type", () => {
		expect(() => S.decodeUnknownSync(EntityListParams)({})).toThrow();
	});

	it("rejects a non-string type", () => {
		expect(() => S.decodeUnknownSync(EntityListParams)({ type: 42 })).toThrow();
	});
});

describe("MessageSearchParams", () => {
	it("rejects a missing query", () => {
		expect(() => S.decodeUnknownSync(MessageSearchParams)({})).toThrow();
	});

	it("rejects a non-string query", () => {
		expect(() =>
			S.decodeUnknownSync(MessageSearchParams)({ query: 42 }),
		).toThrow();
	});
});

describe("MessageHit", () => {
	const wire = {
		message_id: "01900000-0000-7000-8000-000000000040",
		thread_id: "01900000-0000-7000-8000-000000000000",
		run_id: "01900000-0000-7000-8000-000000000001",
		role: "user",
		snippet: "...the daycare schedule...",
		thread_title: "Planning the week",
		created_at: 1_700_000_000_000,
	};

	it("decodes a full hit and encodes back unchanged", () => {
		const decoded = S.decodeUnknownSync(MessageHit)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(MessageHit)(decoded)).toEqual(wire);
	});

	it("rejects an unknown role", () => {
		expect(() =>
			S.decodeUnknownSync(MessageHit)({ ...wire, role: "system" }),
		).toThrow();
	});

	it("rejects a non-number created_at", () => {
		expect(() =>
			S.decodeUnknownSync(MessageHit)({ ...wire, created_at: "today" }),
		).toThrow();
	});
});

describe("MessageSearchResult", () => {
	it("decodes an empty hits array", () => {
		expect(S.decodeUnknownSync(MessageSearchResult)({ hits: [] })).toEqual({
			hits: [],
		});
	});
});

describe("ObservationRecordParams", () => {
	const wire = {
		observations: [
			{
				schema_key: "bodyweight",
				occurred_at: "2026-06-01T07:30:00",
				ended_at: "2026-06-01T07:35:00",
				values: { kg: 72.4 },
				note: "after morning run",
			},
			{
				schema_key: "bodyweight",
				occurred_at: "2026-06-02T07:30:00",
				values: { kg: 72.1 },
			},
		],
		evidence: {
			journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
		},
	};

	it("decodes a batch with evidence and encodes back unchanged", () => {
		const decoded = S.decodeUnknownSync(ObservationRecordParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationRecordParams)(decoded)).toEqual(wire);
	});

	it("decodes the bare optional shape", () => {
		const bare = {
			observations: [
				{
					schema_key: "bodyweight",
					occurred_at: "2026-06-01T07:30:00",
					values: { kg: 72.4 },
				},
			],
		};
		expect(S.decodeUnknownSync(ObservationRecordParams)(bare)).toEqual(bare);
	});

	it("rejects a missing observations array", () => {
		expect(() => S.decodeUnknownSync(ObservationRecordParams)({})).toThrow();
	});
});

describe("ObservationRecordResult", () => {
	it("decodes ids and encodes back unchanged", () => {
		const wire = {
			observation_ids: [
				"0190d3c1-0000-7000-8000-000000000001",
				"0190d3c1-0000-7000-8000-000000000002",
			],
		};
		const decoded = S.decodeUnknownSync(ObservationRecordResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationRecordResult)(decoded)).toEqual(wire);
	});
});

describe("ObservationQueryParams", () => {
	it("decodes every optional filter and encodes back unchanged", () => {
		const wire = {
			schema_keys: ["bodyweight"],
			from: "2026-06-01T00:00:00",
			to: "2026-06-30T23:59:59",
			source_entity_id: "0190d3c1-0000-7000-8000-000000000002",
			source_message_id: "0190d3c1-0000-7000-8000-000000000003",
			limit: 50,
		};
		const decoded = S.decodeUnknownSync(ObservationQueryParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryParams)(decoded)).toEqual(wire);
	});

	it("decodes an empty query", () => {
		expect(S.decodeUnknownSync(ObservationQueryParams)({})).toEqual({});
	});
});

describe("ObservationQueryResult", () => {
	const baseRow = {
		id: "0190d3c1-0000-7000-8000-000000000001",
		schema_key: "bodyweight",
		schema_version: 1,
		occurred_at: "2026-06-01T07:30:00",
		ended_at: "2026-06-01T07:35:00",
		values: { kg: 72.4 },
		note: "after morning run",
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_001,
	};

	const entitySourcedRow = {
		...baseRow,
		source: {
			source_entity_id: "0190d3c1-0000-7000-8000-000000000002",
			relation: "created_from",
		},
	};

	const messageSourcedRow = {
		...baseRow,
		source: {
			source_message_id: "0190d3c1-0000-7000-8000-000000000003",
			relation: "evidenced_by",
		},
	};

	it("decodes an entity-sourced observation row and encodes back unchanged", () => {
		const wire = { observations: [entitySourcedRow] };
		const decoded = S.decodeUnknownSync(ObservationQueryResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryResult)(decoded)).toEqual(wire);
	});

	it("decodes a message-sourced observation row and encodes back unchanged", () => {
		const wire = { observations: [messageSourcedRow] };
		const decoded = S.decodeUnknownSync(ObservationQueryResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryResult)(decoded)).toEqual(wire);
	});

	it("requires explicit nulls for nullable row fields", () => {
		const wire = {
			observations: [
				{
					...entitySourcedRow,
					ended_at: null,
					note: null,
					source: null,
				},
			],
		};
		expect(S.decodeUnknownSync(ObservationQueryResult)(wire)).toEqual(wire);
	});

	it("rejects an unknown source relation", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationQueryResult)({
				observations: [
					{
						...entitySourcedRow,
						source: { ...entitySourcedRow.source, relation: "quoted_in" },
					},
				],
			}),
		).toThrow();
	});
});

describe("ThreadGetParams", () => {
	it("rejects a missing thread_id", () => {
		expect(() => S.decodeUnknownSync(ThreadGetParams)({})).toThrow();
	});
});

describe("RunEvent", () => {
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
	it("rejects a non-boolean connected", () => {
		expect(() =>
			S.decodeUnknownSync(ProviderStatusResult)({
				providers: [{ id: "openai-codex", connected: "yes" }],
			}),
		).toThrow();
	});
});

describe("ProviderLoginStartResult", () => {
	it("rejects a missing authorize_url", () => {
		expect(() => S.decodeUnknownSync(ProviderLoginStartResult)({})).toThrow();
	});
});

describe("ProviderLoginStartParams", () => {
	it("rejects a missing provider", () => {
		expect(() => S.decodeUnknownSync(ProviderLoginStartParams)({})).toThrow();
	});
});

describe("WorkerManifest", () => {
	const valid = {
		run_id: "01900000-0000-7000-8000-000000000abc",
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

	it("rejects a missing run_id", () => {
		const { run_id: _omit, ...noRunId } = valid;
		expect(() => S.decodeUnknownSync(WorkerManifest)(noRunId)).toThrow();
	});

	it("rejects a bare-string entry in workflow.tools", () => {
		expect(() =>
			S.decodeUnknownSync(WorkerManifest)({
				...valid,
				workflow: { ...valid.workflow, tools: ["read_file"] },
			}),
		).toThrow();
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
