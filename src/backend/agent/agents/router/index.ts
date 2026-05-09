/**
 * Router — the freeform-message classifier.
 *
 * Per ADR 0007 the router is a normal `AgentInfo` registry entry whose
 * only job is to read the user's first message, pick a target agent
 * from the registry, and call `dispatch` exactly once. The router is
 * stateless and first-message-only; once `dispatch` resolves, the TUI
 * seam aborts the router's turn and resumes into the child session
 * created by `forkSession()`.
 *
 * Per Q5 / Q6 in the grilling design tree, misroute correction is a
 * NEW freeform message (which spawns a new router session), not a
 * follow-up turn on the original router session.
 *
 * The router has no zones (no filesystem access) and no commands (slash
 * verbs bypass the router by definition — they ARE the classification).
 * `omitBaseTools: true` skips the shared `BASE_TOOLS` (`read` +
 * `update_sidebar`) at compose time, so the router's runtime tool set
 * is exactly `[dispatchTool]`. Without the opt-out, the router would
 * carry `read` with the vault baseline — a misbehaving model could
 * inspect vault files before dispatching, contradicting the
 * classifier-only design.
 */
import { AGENTS } from "../../agents";
import type { AgentInfo } from "../../types";
import { dispatchTool } from "./tools/dispatch";

const ROUTER_DESCRIPTION =
	"Classify a freeform first message and route it to the agent best " +
	"suited to handle it.";

/**
 * Enumerate each non-router agent in the form:
 *
 *   - <name>: <description>
 *     Commands:
 *       /<verb> [argHint] — <description>
 *
 * Programmatic — pulls each agent's `AgentInfo.description` and the
 * `description`/`argHint` of every entry in `AgentInfo.commands`.
 * Adding an agent or a new `AgentCommand` automatically widens the
 * router's prompt without touching this file. Commands without a
 * `description` are skipped (mirrors `composeCommandsBlock` in
 * `compose.ts`); agents with no commands list "(none)" so the router
 * still sees the agent as routable in pure plain-chat mode.
 */
function buildRouterInstructions(): string {
	// `AGENTS` is read at call time (not at module load), so the
	// static-circular `agents.ts` ↔ `agents/router/index.ts` import
	// (agents.ts's registry literal references `routerAgent`; the
	// router needs every other agent for its prompt) only triggers a
	// TDZ throw if a caller imports `routerAgent` BEFORE `agents.ts`
	// has finished evaluating. Production paths reach the registry
	// via `agents.ts` first, so the cycle stays dormant. Tests that
	// import `routerAgent` directly need to also import `AGENTS` (or
	// any symbol from `agents.ts`) first to seed the load order.
	const targets = AGENTS.filter((a) => a.name !== "router");
	const sections = targets.flatMap((a) => {
		const head = `  - ${a.name}: ${a.description}`;
		const commandLines = (a.commands ?? []).flatMap((c) => {
			if (!c.description) return [];
			const verb = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
			return [`      ${verb} — ${c.description}`];
		});
		const commandBlock =
			commandLines.length > 0
				? ["    Commands:", ...commandLines]
				: ["    Commands: (none — plain-chat only)"];
		return [head, ...commandBlock];
	});
	return [
		"You are the Inkstone router. Your job: read the user's first message,",
		"classify it into exactly one target agent, and call the `dispatch`",
		"tool with that agent's name.",
		"",
		"Available agents:",
		...sections,
		"",
		"Match the user's intent against each agent's description and the",
		"verbs they expose. If the user's message looks like one of an",
		"agent's commands (even phrased in prose), prefer that agent. If",
		"unsure between two, prefer the freeform-capable agent.",
		"",
		"Call `dispatch` exactly once. Do not produce any other output.",
	].join("\n");
}

export const routerAgent: AgentInfo = {
	name: "router",
	displayName: "Router",
	description: ROUTER_DESCRIPTION,
	colorKey: "accent",
	extraTools: [dispatchTool],
	zones: [],
	buildInstructions: buildRouterInstructions,
	// One-shot classifier — exactly one tool. See agent docstring above.
	omitBaseTools: true,
};

export { dispatchTool } from "./tools/dispatch";
