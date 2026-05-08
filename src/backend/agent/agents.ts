import { knowledgeBaseAgent } from "./agents/knowledge-base";
import { readerAgent } from "./agents/reader";
import type { AgentInfo } from "./types";

// Adding an agent: see `docs/ARCHITECTURE.md` § Agent Registry → "Adding a new agent".
export const AGENTS: AgentInfo[] = [readerAgent, knowledgeBaseAgent];

// `AGENTS[0]!` is safe — the literal above is non-empty by construction.
// The assertion narrows DEFAULT_AGENT's type under noUncheckedIndexedAccess.
// biome-ignore lint/style/noNonNullAssertion: registry is non-empty by construction
const DEFAULT_INFO = AGENTS[0]!;
export const DEFAULT_AGENT = DEFAULT_INFO.name;

export function getAgentInfo(name: string | undefined | null): AgentInfo {
	return AGENTS.find((a) => a.name === name) ?? DEFAULT_INFO;
}
