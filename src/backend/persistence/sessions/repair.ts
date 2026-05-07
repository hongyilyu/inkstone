/**
 * Load-time alternation repair for `agent_messages` rows.
 *
 * Two classes of corruption can end up on disk when a stream is killed
 * mid-turn (Ctrl+C / process crash between `message_start` and
 * `message_end`):
 *
 *   (a) TAIL ORPHAN — the interrupted turn was the last one in the
 *       session. `agent_messages` ends with a lone `user` row.
 *   (b) INTERIOR GAP — the interrupted turn was followed by a
 *       successful later turn after resume. `agent_messages` has
 *       two adjacent `user` rows with no assistant between them
 *       (first user's reply never committed; second user is the
 *       post-resume prompt).
 *
 * Both shapes hand the provider consecutive user turns on the next
 * prompt: Anthropic silently merges them, Bedrock 400s on
 * `ValidationException`. Synthesize a closing assistant placeholder
 * between every adjacent `user`/`user` pair AND after a trailing
 * `user`, so `agent.state.messages` alternates cleanly. Placeholders
 * never reach a provider — they only fill the alternation slot in
 * `state.messages`. Stored rows are untouched (pure read-time
 * repair); this function is `(rows) => repairedRows` and free of I/O.
 *
 * Alternation is evaluated against the last `user | assistant` role
 * in the output — NOT the direct neighbor — so `toolResult` /
 * `custom` rows between two `user`s don't mask the gap. Without
 * this, `[user, toolResult, user]` (post-tool crash between the
 * second assistant's `message_start` and `message_end`) would
 * escape repair and trip Bedrock 400 on the next prompt.
 *
 * Metadata sourcing: latest prior assistant's `api`/`provider`/
 * `model`, **excluding** synthesized placeholders themselves.
 * Without that skip, sequential dangling gaps would compound — the
 * second placeholder would inherit `model: "placeholder"` from the
 * first. Real user-aborted bubbles match the same skip predicate
 * but their metadata would propagate correctly anyway (same
 * provider/model), so the widening is harmless — documented as
 * accepted behavior in docs/TODO.md.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

/**
 * Marker on synthesized aborted placeholders so the metadata-source
 * search skips them. The literal is also surfaced in the display
 * layer (`DisplayMessage.interrupted` stamp), which matches on the
 * same string.
 */
const INTERRUPTED_MARKER = "[Interrupted by user]";

/**
 * Pure repair pass. Given the `agent_messages` rows as loaded from
 * disk, returns a new array with synthesized assistant placeholders
 * inserted wherever the alternation invariant is violated.
 */
export function repairAlternation(rows: AgentMessage[]): AgentMessage[] {
	const repaired: AgentMessage[] = [];
	for (const msg of rows) {
		if (lastAlternationRole(repaired) === "user" && msg.role === "user") {
			const priorAssistant = findLatestRealAssistant(repaired);
			repaired.push(buildAbortedAssistant(priorAssistant));
		}
		repaired.push(msg);
	}
	if (lastAlternationRole(repaired) === "user") {
		const priorAssistant = findLatestRealAssistant(repaired);
		repaired.push(buildAbortedAssistant(priorAssistant));
	}
	return repaired;
}

/**
 * Role of the last alternation-relevant message (`user | assistant`),
 * skipping `toolResult` / `custom` rows that sit between a user turn
 * and its closing assistant. Used by the load-time repair so a
 * `toolResult` doesn't mask a `[user, user]` gap.
 */
function lastAlternationRole(
	list: AgentMessage[],
): "user" | "assistant" | null {
	for (let i = list.length - 1; i >= 0; i--) {
		const r = list[i]?.role;
		if (r === "user" || r === "assistant") return r;
	}
	return null;
}

/**
 * Latest assistant message whose metadata (`api`/`provider`/`model`)
 * is safe to propagate onto a fresh synthesized placeholder. Skips
 * synthesized placeholders themselves so sequential dangling-user
 * gaps don't compound.
 */
function findLatestRealAssistant(
	list: AgentMessage[],
): AssistantMessage | undefined {
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i];
		if (m && m.role === "assistant" && !isSynthesizedAbort(m)) return m;
	}
	return undefined;
}

function isSynthesizedAbort(m: AssistantMessage): boolean {
	return m.stopReason === "aborted" && m.errorMessage === INTERRUPTED_MARKER;
}

function buildAbortedAssistant(
	prior: AssistantMessage | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		// Bland-default api/provider values used only when there's no
		// prior assistant message to inherit from (fresh session,
		// dangling user at index 0). Never sent to a provider — the
		// synthesized placeholder exists purely to satisfy the
		// alternation invariant pi-agent-core's `convertToLlm`
		// expects. Values match an existing shipped provider entry
		// (OpenRouter's `openai-completions` API) so pi-ai's model
		// registry round-trips cleanly if the placeholder ever
		// reaches a conversion path.
		api: prior?.api ?? ("openai-completions" as AssistantMessage["api"]),
		provider: prior?.provider ?? ("openrouter" as AssistantMessage["provider"]),
		model: prior?.model ?? "placeholder",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "aborted",
		errorMessage: INTERRUPTED_MARKER,
		timestamp: Date.now(),
	};
}
