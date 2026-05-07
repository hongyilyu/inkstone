/**
 * Pure unit tests for the alternation-repair pass.
 *
 * `loadSession`'s end-to-end behavior is covered by
 * `test/resume-repair.test.ts` (which seeds the SQLite DB and asserts
 * on the loaded shape). These tests instead drive `repairAlternation`
 * directly with hand-rolled `AgentMessage[]` inputs so the repair
 * logic can be exercised without DB plumbing — and so a regression
 * that drops a branch trips a focused failure here rather than an
 * indirect one in `resume-repair`.
 */

import { describe, expect, test } from "bun:test";
import { repairAlternation } from "@backend/persistence/sessions/repair";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

function userMsg(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function assistantMsg(partial?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "anthropic/claude-opus-4.7",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...partial,
	};
}

const INTERRUPTED = "[Interrupted by user]";

describe("repairAlternation", () => {
	test("clean alternation passes through unchanged", () => {
		const input: AgentMessage[] = [
			userMsg("hi"),
			assistantMsg(),
			userMsg("bye"),
			assistantMsg(),
		];
		const out = repairAlternation(input);
		expect(out).toEqual(input);
	});

	test("tail orphan (last row is user) gets a synthesized closer", () => {
		const out = repairAlternation([userMsg(":q")]);
		expect(out.length).toBe(2);
		const tail = out[1] as AssistantMessage;
		expect(tail.role).toBe("assistant");
		expect(tail.stopReason).toBe("aborted");
		expect(tail.errorMessage).toBe(INTERRUPTED);
		// Empty-text content — non-empty would leak into the next prompt.
		expect(tail.content).toEqual([{ type: "text", text: "" }]);
	});

	test("interior gap (user, user) gets a placeholder between them", () => {
		const out = repairAlternation([
			userMsg("first"),
			userMsg("second"),
			assistantMsg(),
		]);
		expect(out.length).toBe(4);
		expect(out[0]?.role).toBe("user");
		expect(out[1]?.role).toBe("assistant");
		expect((out[1] as AssistantMessage).stopReason).toBe("aborted");
		expect((out[1] as AssistantMessage).errorMessage).toBe(INTERRUPTED);
		expect(out[2]?.role).toBe("user");
		expect(out[3]?.role).toBe("assistant");
		expect((out[3] as AssistantMessage).stopReason).toBe("stop");
	});

	test("toolResult between users does not mask the gap", () => {
		// Without the lastAlternationRole helper, a toolResult between
		// two users would be mistaken for the previous turn's closing
		// row and the alternation gap would escape repair.
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			content: [{ type: "text", text: "tool out" }],
			isError: false,
			timestamp: 0,
		};
		const out = repairAlternation([
			userMsg("first"),
			toolResult,
			userMsg("second (orphan)"),
		]);
		// user, toolResult, synthesized assistant, user, synthesized assistant.
		expect(out.length).toBe(5);
		expect(out[0]?.role).toBe("user");
		expect(out[1]?.role).toBe("toolResult");
		expect(out[2]?.role).toBe("assistant");
		expect((out[2] as AssistantMessage).stopReason).toBe("aborted");
		expect(out[3]?.role).toBe("user");
		expect(out[4]?.role).toBe("assistant");
		expect((out[4] as AssistantMessage).stopReason).toBe("aborted");
	});

	test("placeholder inherits api/provider/model from the latest real assistant", () => {
		const out = repairAlternation([
			userMsg("first"),
			assistantMsg({
				api: "openai-completions",
				provider: "openai",
				model: "gpt-5",
			}),
			userMsg("second (orphan)"),
		]);
		expect(out.length).toBe(4);
		const tail = out[3] as AssistantMessage;
		expect(tail.api).toBe("openai-completions");
		expect(tail.provider).toBe("openai");
		expect(tail.model).toBe("gpt-5");
	});

	test("sequential dangling gaps do not compound placeholder metadata", () => {
		// Without the synthesized-abort skip in findLatestRealAssistant,
		// the second placeholder would inherit `model: "placeholder"`
		// from the first instead of falling back to the bland default.
		const out = repairAlternation([
			userMsg("first"),
			userMsg("second"),
			userMsg("third"),
		]);
		// user, synth, user, synth, user, synth.
		expect(out.length).toBe(6);
		const placeholder1 = out[1] as AssistantMessage;
		const placeholder2 = out[3] as AssistantMessage;
		const placeholder3 = out[5] as AssistantMessage;
		expect(placeholder1.model).toBe("placeholder");
		expect(placeholder2.model).toBe("placeholder");
		expect(placeholder3.model).toBe("placeholder");
	});

	test("empty input passes through unchanged", () => {
		expect(repairAlternation([])).toEqual([]);
	});

	test("dangling user at index 0 gets bland-default metadata", () => {
		const out = repairAlternation([userMsg(":q")]);
		const tail = out[1] as AssistantMessage;
		expect(tail.api).toBe("openai-completions");
		expect(tail.provider).toBe("openrouter");
		expect(tail.model).toBe("placeholder");
	});
});
