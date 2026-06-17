import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";

// Manifest codec: the pure translation from a WorkerManifest's assembled history
// into pi `Message[]` (ADR-0025). Mirrors the Web side's entityCodec — a seam
// the interpreter depends on so its body reads as pure orchestration and this
// mapping is testable at its own interface, without driving the agent loop.

/** Map the manifest's assembled history into pi `Message[]` — see docs/design/worker.md (ADR-0025). */
function toAgentMessages(manifest: WorkerManifest): AgentMessage[] {
	const now = Date.now();
	const history: Message[] = manifest.messages.map((m): Message => {
		if (m.role === "user") {
			return { role: "user", content: m.text, timestamp: now };
		}
		if (m.role === "tool_result") {
			return {
				role: "toolResult",
				toolCallId: m.tool_call_id,
				toolName: "",
				content: [{ type: "text", text: m.content }],
				isError: m.is_error ?? false,
				timestamp: now,
			};
		}
		const assistant: Message & { role: "assistant" } = {
			role: "assistant",
			content: [],
			api: "",
			provider: "",
			model: manifest.workflow.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		};
		if (m.text !== undefined) {
			assistant.content.push({ type: "text", text: m.text });
		}
		for (const tc of m.tool_calls ?? []) {
			assistant.content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: (tc.arguments ?? {}) as Record<string, unknown>,
			});
		}
		return assistant;
	});
	return history as AgentMessage[];
}

/**
 * The manifest codec. One direction today (manifest history → pi messages);
 * named as a record to mirror the Web `entityCodec` seam and leave room for a
 * reverse mapping if one is ever needed.
 */
export const manifestCodec = {
	toAgentMessages,
};
