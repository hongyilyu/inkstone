import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import { manifestCodec } from "../src/manifest-codec.js";

// Direct unit tests for the manifest codec (ADR-0025): the pure
// WorkerManifest-history → pi `Message[]` translation, asserted at its own
// interface without driving the agent loop (the interpreter tests cover the
// orchestration around it).

function manifest(messages: WorkerManifest["messages"]): WorkerManifest {
	return {
		run_id: "01900000-0000-7000-8000-000000000abc",
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You are a test assistant.",
			thinking_level: "off",
			tools: [],
		},
		prompt: "hello",
		messages,
	};
}

// The codec returns pi's structured `AgentMessage[]`; tests assert on its
// observable fields directly off those types.
const roles = (out: AgentMessage[]): string[] => out.map((m) => m.role);

/** The codec's output narrowed to the LLM roles it produces. `AgentMessage` also
 * spans pi's bash-execution variant, which this codec never emits, so the tests
 * assert against the same `Message` set `runInterpreter`'s `convertToLlm` keeps. */
const llm = (out: AgentMessage[]): Message[] =>
	out.filter(
		(m): m is Message =>
			m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	);

/** An assistant message's content BLOCKS (a user/toolResult message carries a
 * string or its own blocks, which these assertions don't read). */
const blocks = (msg: Message) =>
	Array.isArray(msg.content) ? msg.content : [];

describe("manifestCodec.toAgentMessages", () => {
	it("maps an empty history to an empty array", () => {
		expect(manifestCodec.toAgentMessages(manifest([]))).toEqual([]);
	});

	it("maps a user message to a pi user message", () => {
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([{ role: "user", text: "buy milk" }]),
			),
		);
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("buy milk");
		expect(msg.timestamp).toEqual(expect.any(Number));
	});

	it("maps a tool_result's TranscriptToolResult to a pi toolResult paired by id", () => {
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "tool_result",
						tool_call_id: "tc_1",
						result: {
							content: [{ type: "text", text: "Accepted." }],
							is_error: false,
						},
					},
				]),
			),
		);
		expect(msg).toMatchObject({
			role: "toolResult",
			toolCallId: "tc_1",
			content: [{ type: "text", text: "Accepted." }],
			isError: false,
		});
	});

	it("carries the result's is_error into the pi toolResult", () => {
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "tool_result",
						tool_call_id: "tc_1",
						result: {
							content: [{ type: "text", text: "boom" }],
							is_error: true,
						},
					},
				]),
			),
		);
		expect(msg).toMatchObject({ isError: true });
	});

	it("restores each tool_result's tool NAME from its paired assistant call", () => {
		// external-task-views A4: pi replays a provider-valid transcript only if
		// the toolResult carries its call's name — derived from the manifest's
		// assistant tool_calls, no extra wire field.
		const out = manifestCodec.toAgentMessages(
			manifest([
				{
					role: "assistant",
					tool_calls: [
						{
							id: "tc_ext",
							name: "ticktick_filter_tasks",
							arguments: { filter: { status: [0] } },
						},
					],
				},
				{
					role: "tool_result",
					tool_call_id: "tc_ext",
					result: {
						content: [{ type: "text", text: "1 task found" }],
						is_error: false,
					},
				},
				{
					role: "tool_result",
					tool_call_id: "tc_unknown",
					result: { content: [], is_error: false },
				},
			]),
		);
		const results = out.filter((m) => m.role === "toolResult");
		expect(results[0].toolName).toBe("ticktick_filter_tasks");
		// An unpaired result degrades to the empty name rather than throwing.
		expect(results[1].toolName).toBe("");
	});

	it("synthesizes an assistant message carrying the workflow model, text, and tool calls", () => {
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "assistant",
						text: "on it",
						tool_calls: [
							{
								id: "tc_1",
								name: "propose_workspace_mutation",
								arguments: { mutation_kind: "create_journal_entry" },
							},
						],
					},
				]),
			),
		);
		expect(msg).toMatchObject({
			role: "assistant",
			model: "faux-1",
			stopReason: "stop",
		});
		expect(blocks(msg)).toEqual([
			{ type: "text", text: "on it" },
			{
				type: "toolCall",
				id: "tc_1",
				name: "propose_workspace_mutation",
				arguments: { mutation_kind: "create_journal_entry" },
			},
		]);
	});

	it("omits the text block when an assistant message has only tool calls", () => {
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "assistant",
						tool_calls: [{ id: "tc_1", name: "read_thread", arguments: {} }],
					},
				]),
			),
		);
		expect(blocks(msg).length).toBe(1);
		expect(blocks(msg)[0]).toMatchObject({ type: "toolCall" });
	});

	it("keeps just the text block when an assistant message has no tool calls", () => {
		// Text-only assistant (no `tool_calls` key) is a valid manifest shape —
		// exercises the `m.tool_calls ?? []` undefined fallback at its own interface.
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([{ role: "assistant", text: "just talking" }]),
			),
		);
		expect(msg.content).toEqual([{ type: "text", text: "just talking" }]);
	});

	it("coerces a non-object tool-call arguments payload to an empty object", () => {
		// `arguments` is un-decoded JSON on the wire — a string/array/null is valid
		// JSON but must not reach the toolCall as a non-object.
		const [msg] = llm(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "assistant",
						tool_calls: [
							{ id: "tc_1", name: "read_thread", arguments: "oops" },
						],
					},
				]),
			),
		);
		expect(blocks(msg)[0]).toMatchObject({ arguments: {} });
	});

	it("preserves order across a mixed transcript", () => {
		const out = manifestCodec.toAgentMessages(
			manifest([
				{ role: "user", text: "do it" },
				{
					role: "assistant",
					tool_calls: [{ id: "tc_1", name: "read_thread", arguments: {} }],
				},
				{
					role: "tool_result",
					tool_call_id: "tc_1",
					result: { content: [{ type: "text", text: "ok" }], is_error: false },
				},
			]),
		);
		expect(roles(out)).toEqual(["user", "assistant", "toolResult"]);
	});
});
