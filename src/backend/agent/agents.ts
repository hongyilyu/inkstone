import { exampleAgent } from "./agents/example";
import { readerAgent } from "./agents/reader";
import type { AgentInfo } from "./base";

/**
 * Static agent registry. Each agent lives in its own self-contained
 * folder under `./agents/<name>/` and exports its `AgentInfo` literal.
 * This file is the single place that enumerates them, so adding a new
 * agent is: one new folder under `agents/` + one import + one array
 * entry here.
 *
 * The registry is never mutated at runtime, so frontends can import it
 * directly rather than going through the bridge — only the *selected*
 * agent name crosses as reactive state (`AgentStoreState.currentAgent`).
 */
export const AGENTS: AgentInfo[] = [readerAgent, exampleAgent];

// Invariant: the registry literal above is non-empty, so `AGENTS[0]`
// exists. The non-null assertion keeps `DEFAULT_AGENT` / `getAgentInfo`
// return types narrow to `AgentInfo` (rather than `AgentInfo | undefined`)
// under `noUncheckedIndexedAccess`.
// biome-ignore lint/style/noNonNullAssertion: registry is non-empty by construction
const DEFAULT_INFO = AGENTS[0]!;
export const DEFAULT_AGENT = DEFAULT_INFO.name;

export function getAgentInfo(name: string | undefined | null): AgentInfo {
	return AGENTS.find((a) => a.name === name) ?? DEFAULT_INFO;
}
