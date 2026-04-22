import type { AgentTool } from "@mariozechner/pi-agent-core";
import { buildSystemPrompt as buildReaderPrompt } from "./prompt";
import { editFileTool } from "./tools/edit-file";
import { quoteArticleTool } from "./tools/quote-article";
import { readFileTool } from "./tools/read-file";
import { writeFileTool } from "./tools/write-file";

/**
 * Theme keys used for per-agent accents. Must match keys on `ThemeColors`
 * (see `src/tui/context/theme.tsx`). Declared as a string union so bad keys
 * fail at compile time when a new agent is added.
 */
export type AgentColorKey =
	| "secondary"
	| "accent"
	| "primary"
	| "success"
	| "warning"
	| "error"
	| "info";

/**
 * A named agent persona. The registry is static (never changes at runtime),
 * so there's no need to expose it through the bridge — frontends can import
 * this module directly.
 *
 * `buildSystemPrompt` receives the currently-active article (set via
 * `/article <file>`) so reader-style agents can embed it; non-reader agents
 * ignore the argument. Keeping this as an argument rather than a module-level
 * read avoids a circular import with `agent/index.ts`, which owns the
 * `activeArticle` state.
 */
export interface AgentInfo {
	name: string;
	displayName: string;
	description: string;
	colorKey: AgentColorKey;
	tools: AgentTool<any>[];
	buildSystemPrompt(activeArticle: string | null): string;
}

export const AGENTS: AgentInfo[] = [
	{
		name: "reader",
		displayName: "Reader",
		description: "Obsidian reading guide",
		colorKey: "secondary",
		tools: [readFileTool, editFileTool, writeFileTool, quoteArticleTool],
		buildSystemPrompt: (activeArticle) => buildReaderPrompt(activeArticle),
	},
	{
		name: "example",
		displayName: "Example",
		description: "General-purpose chat assistant (no tools)",
		colorKey: "accent",
		tools: [],
		buildSystemPrompt: () =>
			"You are a helpful, concise general-purpose assistant. Answer the user's questions directly. You have no tools available.",
	},
];

// Invariant: the registry literal above is non-empty, so `AGENTS[0]` exists.
// Using a non-null assertion here keeps `DEFAULT_AGENT` / `getAgentInfo` return
// types narrow to `AgentInfo` (rather than `AgentInfo | undefined`) under
// `noUncheckedIndexedAccess`.
// biome-ignore lint/style/noNonNullAssertion: registry is non-empty by construction
const DEFAULT_INFO = AGENTS[0]!;
export const DEFAULT_AGENT = DEFAULT_INFO.name;

export function getAgentInfo(name: string | undefined | null): AgentInfo {
	return AGENTS.find((a) => a.name === name) ?? DEFAULT_INFO;
}
