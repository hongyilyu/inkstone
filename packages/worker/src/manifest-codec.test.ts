import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { WorkerManifest } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import { manifestCodec } from "./manifest-codec.js";

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

// Read codec output as plain records for field assertions (the codec returns
// pi's structured `AgentMessage[]`; tests assert on its observable fields).
type AnyMsg = Record<string, unknown>;
const asRecords = (out: AgentMessage[]): AnyMsg[] => out as unknown as AnyMsg[];
const roles = (out: AgentMessage[]): string[] =>
	asRecords(out).map((m) => m.role as string);

describe("manifestCodec.toAgentMessages", () => {
	it("maps an empty history to an empty array", () => {
		expect(manifestCodec.toAgentMessages(manifest([]))).toEqual([]);
	});

	it("maps a user message to a pi user message", () => {
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([{ role: "user", text: "buy milk" }]),
			),
		);
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("buy milk");
		expect(typeof msg.timestamp).toBe("number");
	});

	it("maps a tool_result to a pi toolResult paired by id, defaulting isError", () => {
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([
					{ role: "tool_result", tool_call_id: "tc_1", content: "Accepted." },
				]),
			),
		);
		expect(msg.role).toBe("toolResult");
		expect(msg.toolCallId).toBe("tc_1");
		expect(msg.content).toEqual([{ type: "text", text: "Accepted." }]);
		expect(msg.isError).toBe(false);
	});

	it("honors an explicit is_error on a tool_result", () => {
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "tool_result",
						tool_call_id: "tc_1",
						content: "boom",
						is_error: true,
					},
				]),
			),
		);
		expect(msg.isError).toBe(true);
	});

	it("synthesizes an assistant message carrying the workflow model, text, and tool calls", () => {
		const [msg] = asRecords(
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
		expect(msg.role).toBe("assistant");
		expect(msg.model).toBe("faux-1");
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([
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
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "assistant",
						tool_calls: [{ id: "tc_1", name: "read_thread", arguments: {} }],
					},
				]),
			),
		);
		expect((msg.content as unknown[]).length).toBe(1);
		expect((msg.content as AnyMsg[])[0].type).toBe("toolCall");
	});

	it("keeps just the text block when an assistant message has no tool calls", () => {
		// Text-only assistant (no `tool_calls` key) is a valid manifest shape —
		// exercises the `m.tool_calls ?? []` undefined fallback at its own interface.
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([{ role: "assistant", text: "just talking" }]),
			),
		);
		expect(msg.content).toEqual([{ type: "text", text: "just talking" }]);
	});

	it("coerces a non-object tool-call arguments payload to an empty object", () => {
		// `arguments` is S.Unknown on the wire — a string/array/null must not reach
		// the toolCall as a non-object. Cast through unknown to feed an invalid shape.
		const [msg] = asRecords(
			manifestCodec.toAgentMessages(
				manifest([
					{
						role: "assistant",
						tool_calls: [
							{ id: "tc_1", name: "read_thread", arguments: "oops" as unknown },
						],
					},
				] as WorkerManifest["messages"]),
			),
		);
		expect((msg.content as AnyMsg[])[0].arguments).toEqual({});
	});

	it("preserves order across a mixed transcript", () => {
		const out = manifestCodec.toAgentMessages(
			manifest([
				{ role: "user", text: "do it" },
				{
					role: "assistant",
					tool_calls: [{ id: "tc_1", name: "read_thread", arguments: {} }],
				},
				{ role: "tool_result", tool_call_id: "tc_1", content: "ok" },
			]),
		);
		expect(roles(out)).toEqual(["user", "assistant", "toolResult"]);
	});
});
