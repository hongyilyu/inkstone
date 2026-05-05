/**
 * `suggest_command` tool factory.
 *
 * Lets the LLM propose a slash command on the user's behalf when a
 * freeform request matches one of the agent's declared verbs. The tool
 * blocks until the user responds via a TUI-side panel; the host then
 * replays the confirmed slash as if the user had typed it.
 *
 * Resolver pattern mirrors `permissions.ts`'s `confirmFn` — a TUI-
 * injected callback consumed on every tool call, fail-closed default
 * when unset so headless callers see a clear "cancelled" result
 * rather than the tool hanging.
 *
 * Schema enumerates each agent's command names so the LLM picks from a
 * fixed set at schema-validation time. Agents without any commands get
 * no tool at all — `makeSuggestCommandTool` returns `null` and
 * `composeTools` filters it out.
 *
 * The tool does NOT dispatch the slash itself. It returns a structured
 * result describing the user's decision; the host reads the result
 * post-turn-end and fires the replay. Keeping dispatch out of the
 * tool's execute path preserves pi-agent-core's one-turn-at-a-time
 * invariant: starting a fresh user turn from inside a running turn's
 * tool call would re-enter the Agent state machine.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import type { AgentCommand } from "../types";

/**
 * User decision captured by the TUI-side panel. Mirrors the three
 * buttons in `SuggestCommandPrompt`.
 *
 * - `confirmed` — user accepted; the host should replay
 *   `/<command> <args>` as a fresh user turn after the current turn
 *   ends.
 * - `edited` — user asked to edit; the host pre-populates the prompt
 *   textarea with the slash and lets the user adjust it. No replay.
 * - `cancelled` — user rejected, escaped, or the panel unmounted
 *   while the tool was in-flight. No replay.
 */
export type SuggestCommandDecision = "confirmed" | "edited" | "cancelled";

export interface SuggestCommandRequest {
	callId: string;
	/** Slash command name without leading `/`. Always one of the agent's declared commands. */
	command: string;
	/** Argument payload the LLM wants to pass. May be empty when the command takes no args. */
	args: string;
	/** LLM-authored rationale rendered in the panel body. */
	rationale: string;
}

export type SuggestCommandFn = (
	req: SuggestCommandRequest,
) => Promise<SuggestCommandDecision>;

let suggestCommandFn: SuggestCommandFn | null = null;

/**
 * Install the TUI-side resolver. Parallel to `setConfirmFn` in
 * `permissions.ts` — the provider captures the previous value and
 * restores it on unmount so re-mounts (tests, future HMR) don't pin a
 * disposed closure.
 */
export function setSuggestCommandFn(fn: SuggestCommandFn | null): void {
	suggestCommandFn = fn;
}

export function getSuggestCommandFn(): SuggestCommandFn | null {
	return suggestCommandFn;
}

/**
 * Structured details attached to the `AgentToolResult` so the TUI
 * reducer can render a specific `ToolPart` state for the suggestion.
 * Today the reducer treats it the same as any other tool result; this
 * field exists so a future polish pass can swap the one-line args
 * rendering for a richer "suggested /article foo.md — user accepted"
 * row without changing the tool's return shape.
 */
export interface SuggestCommandDetails {
	command: string;
	args: string;
	rationale: string;
	decision: SuggestCommandDecision;
}

/**
 * Build the tool for a given agent's command list. Returns `null` when
 * the agent has no commands — schema-wise we can't build an empty
 * enum, and a suggest tool with no targets is user-confusing rather
 * than no-op.
 */
export function makeSuggestCommandTool(
	commands: readonly AgentCommand[],
): AgentTool<ReturnType<typeof buildSchema>, SuggestCommandDetails> | null {
	if (commands.length === 0) return null;
	const parameters = buildSchema(commands);

	return {
		name: "suggest_command",
		label: "Suggest Command",
		description:
			"Propose a slash command on the user's behalf when their request clearly maps to one of the agent's verbs. " +
			"The user sees a panel with the proposed command and your rationale, and can accept, edit, or cancel. " +
			"Use this when routing a freeform request to a command you've already narrowed down — e.g. after `search` " +
			"identified a specific article the user asked for. Do not use this for questions you can answer in prose.",
		parameters,
		async execute(
			callId: string,
			params: Static<typeof parameters>,
		): Promise<AgentToolResult<SuggestCommandDetails>> {
			const fn = suggestCommandFn;
			const req: SuggestCommandRequest = {
				callId,
				command: params.command,
				args: params.args ?? "",
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
				// End the turn after a suggestion. A confirmed suggestion
				// triggers a fresh user turn (host-side post-turn replay);
				// anything the LLM would say after "user confirmed" races
				// that replay. Edited/cancelled decisions leave the user
				// to drive next steps. Either way, the LLM has no useful
				// follow-up to add mid-turn.
				terminate: true,
			};
		},
	};
}

function buildSchema(commands: readonly AgentCommand[]) {
	// typebox's `Type.Union` of `Type.Literal` produces an enum schema
	// that schema-validates the LLM's `command` against the agent's
	// exact command names. Single-command agents still need a union
	// (typebox rejects `Type.Union([x])` with one member — use the
	// literal directly instead).
	const names = commands.map((c) => Type.Literal(c.name));
	// biome-ignore lint/style/noNonNullAssertion: guarded by caller (commands.length >= 1)
	const commandField = names.length === 1 ? names[0]! : Type.Union(names);

	return Type.Object({
		command: commandField,
		args: Type.Optional(
			Type.String({
				description:
					"Argument payload for the command (what the user would type after the verb). Empty string when the command takes no arguments.",
			}),
		),
		rationale: Type.String({
			description:
				"A one-sentence plain-language explanation for why this command fits the user's request. Shown to the user in the confirmation panel.",
		}),
	});
}
