import type { AgentInfo } from "../../base";

/**
 * Example — a minimal general-purpose chat assistant. Kept as a smoke-
 * test target for the agent shell: no extra tools, 1-line prompt. The
 * `read_file` tool is still available via `BASE_TOOLS`; everything
 * else is absent.
 */
export const exampleAgent: AgentInfo = {
	name: "example",
	displayName: "Example",
	description: "General-purpose chat assistant",
	colorKey: "accent",
	extraTools: [],
	buildInstructions: () =>
		"You are a helpful, concise general-purpose assistant. Answer the user's questions directly.",
};
