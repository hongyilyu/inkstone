import { knowledgeBaseAgent } from "./agents/knowledge-base";
import { readerAgent } from "./agents/reader";
import { routerAgent } from "./agents/router";
import type { AgentInfo } from "./types";

// Adding an agent: see `docs/ARCHITECTURE.md` § Agent Registry → "Adding a new agent".
export const AGENTS: AgentInfo[] = [
	routerAgent,
	readerAgent,
	knowledgeBaseAgent,
];

/**
 * Open-page default agent — named explicitly rather than encoded as
 * `AGENTS[0]` so reordering the registry doesn't silently change which
 * agent receives freeform open-page messages. Per ADR 0007, freeform
 * input lands on the router by default; slash and Tab picks bypass it.
 */
export const DEFAULT_AGENT_NAME = "router";

const DEFAULT_INFO =
	AGENTS.find((a) => a.name === DEFAULT_AGENT_NAME) ??
	(() => {
		throw new Error(
			`Default agent '${DEFAULT_AGENT_NAME}' is not registered in AGENTS.`,
		);
	})();
export const DEFAULT_AGENT = DEFAULT_INFO.name;

export function getAgentInfo(name: string | undefined | null): AgentInfo {
	return AGENTS.find((a) => a.name === name) ?? DEFAULT_INFO;
}
