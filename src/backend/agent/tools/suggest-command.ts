/**
 * `suggest_command` tool — lets the LLM propose a user-facing slash
 * invocation for a verb the agent declares (see `docs/AGENT-DESIGN.md`
 * D15). The tool blocks on a TUI-side resolver; on confirm the host
 * replays the slash via `command.triggerSlash`, which bottoms out in
 * `actions.prompt`'s `agent.followUp` branch so pi-agent-core drains
 * the fresh turn at the natural end of the current run.
 *
 * Resolver pattern mirrors `permissions.ts`'s `confirmFn`: TUI-injected
 * callback, fail-closed `"cancelled"` when unset so headless callers
 * don't hang.
 *
 * Schema constrains the invocation to the agent's command names so the
 * LLM can only propose a verb that actually exists. Empty commands → no tool
 * (`composeTools` filters the `null` out).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import type { AgentCommand, InkstoneTool } from "../types";

/** User decision from the confirm panel; `edited` does not replay. */
export type SuggestCommandDecision = "confirmed" | "edited" | "cancelled";

export interface SuggestCommandRequest {
	callId: string;
	/** Command name without leading `/`. */
	command: string;
	/** May be empty for arg-less verbs. */
	args: string;
	rationale: string;
}

export type SuggestCommandFn = (
	req: SuggestCommandRequest,
) => Promise<SuggestCommandDecision>;

let suggestCommandFn: SuggestCommandFn | null = null;

/** Install the TUI-side resolver. Provider captures/restores on
 * unmount, same pattern as `setConfirmFn`. */
export function setSuggestCommandFn(fn: SuggestCommandFn | null): void {
	suggestCommandFn = fn;
}

export function getSuggestCommandFn(): SuggestCommandFn | null {
	return suggestCommandFn;
}

export interface SuggestCommandDetails {
	command: string;
	args: string;
	rationale: string;
	decision: SuggestCommandDecision;
}

/** Returns `null` when the agent has no commands (empty enum is not
 * a valid schema). */
export function makeSuggestCommandTool(
	commands: readonly AgentCommand[],
): InkstoneTool<ReturnType<typeof buildSchema>, SuggestCommandDetails> | null {
	if (commands.length === 0) return null;
	const parameters = buildSchema(commands);

	return {
		name: "suggest_command",
		label: "Suggest Command",
		// Slash-command proposal — no filesystem access; resolves
		// through the TUI confirm panel. Empty baseline is the
		// explicit "no rules apply" declaration.
		baseline: [],
		description:
			"Propose an exact slash invocation on the user's behalf when their request clearly maps to one of the agent's verbs. " +
			"The user sees a panel with the proposed invocation and your rationale, and can accept, edit, or cancel. " +
			"Use this when routing a freeform request to a command you've already narrowed down — e.g. after `search` " +
			"identified a specific article the user asked for. Pass the full slash text in `invocation`, such as `/article foo.md`. " +
			"Do not use this for questions you can answer in prose.",
		parameters,
		async execute(
			callId: string,
			params: Static<typeof parameters>,
		): Promise<AgentToolResult<SuggestCommandDetails>> {
			const fn = suggestCommandFn;
			const parsed = parseInvocation(params.invocation);
			const req: SuggestCommandRequest = {
				callId,
				command: parsed.command,
				args: parsed.args,
				rationale: params.rationale,
			};
			const decision: SuggestCommandDecision = fn ? await fn(req) : "cancelled";
			const details: SuggestCommandDetails = {
				command: req.command,
				args: req.args,
				rationale: req.rationale,
				decision,
			};
			const summary =
				decision === "confirmed"
					? `User confirmed; /${req.command}${req.args ? ` ${req.args}` : ""} will run as a new turn.`
					: decision === "edited"
						? `User chose to edit; /${req.command} was placed into the prompt for review.`
						: `User cancelled the suggestion.`;
			return {
				content: [{ type: "text", text: summary }],
				details,
				// Cut the loop short — any LLM follow-up would race the post-turn replay.
				terminate: true,
			};
		},
	};
}

function buildSchema(commands: readonly AgentCommand[]) {
	return Type.Object({
		invocation: Type.String({
			pattern: buildInvocationPattern(commands),
			description:
				"The exact slash command the user would type, including the leading `/` and any arguments, e.g. `/article foo.md`.",
		}),
		rationale: Type.String({
			description:
				"A one-sentence plain-language explanation for why this command fits the user's request. Shown to the user in the confirmation panel.",
		}),
	});
}

function parseInvocation(invocation: string): {
	command: string;
	args: string;
} {
	const trimmed = invocation.trim();
	const withoutSlash = trimmed.slice(1);
	const spaceAt = withoutSlash.search(/\s/);
	if (spaceAt === -1) return { command: withoutSlash, args: "" };
	return {
		command: withoutSlash.slice(0, spaceAt),
		args: withoutSlash.slice(spaceAt + 1).trim(),
	};
}

function buildInvocationPattern(commands: readonly AgentCommand[]): string {
	const branches = commands.map((command) => {
		const name = escapeRegExp(command.name);
		if (command.takesArgs) return `/${name}\\s+\\S[\\s\\S]*`;
		if (command.argHint) return `/${name}(?:\\s+[\\s\\S]*)?`;
		return `/${name}\\s*`;
	});
	return `^(?:${branches.join("|")})$`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
