import type { AgentCommand, AgentInfo } from "../../base";
import { editTool, writeTool } from "../../tools";
import { buildReaderInstructions } from "./instructions";

/**
 * Reader's session state — the currently-open article, if any. Reader
 * owns this rather than the shell (`backend/agent/index.ts`) because
 * it's reader-specific vocabulary, not a generic shell concept. The
 * shell reads via `getActiveArticle()` for the `beforeToolCall` guard
 * injection, and resets via `setActiveArticle(null)` on session clear.
 *
 * Reader's `/article` command mutates this state and then triggers a
 * prompt turn asking the agent to start the reading workflow.
 */
let activeArticle: string | null = null;

export function getActiveArticle(): string | null {
	return activeArticle;
}

export function setActiveArticle(id: string | null): void {
	activeArticle = id;
}

/**
 * `/article <filename>` — reader's canonical verb. Sets the active
 * article, rebuilds the system prompt so `buildInstructions()` picks
 * up the new article context, then kicks off an LLM turn asking the
 * agent to start the reading workflow.
 *
 * Empty args are a no-op (user typed `/article` with nothing after).
 * The submit handler in `prompt.tsx` already guards against that by
 * leaving the token as a plain prompt, but the check here is defensive.
 */
const articleCommand: AgentCommand = {
	name: "article",
	description: "Open an article for guided reading",
	argHint: "<filename>",
	takesArgs: true,
	execute: async (args, ctx) => {
		const articleId = args.trim();
		if (!articleId) return;
		setActiveArticle(articleId);
		ctx.refreshSystemPrompt();
		await ctx.prompt(`Read ${articleId}`);
	},
};

/**
 * Reader — the Obsidian reading guide. Walks the user through the
 * 6-stage reading workflow (see `./instructions.ts`) and manages
 * article frontmatter edits, scraps, and notes inside the vault.
 *
 * Tools: `read` comes from `BASE_TOOLS`; `edit` + `write` are pulled
 * from the shared pool in `backend/agent/tools.ts`. Model-side, the
 * LLM sees the declaration order `[read, edit, write]` — provider
 * prompt caches (Anthropic/Bedrock/OpenAI) key on the byte-exact
 * tools prefix, so the order is worth preserving across refactors.
 *
 * `buildInstructions` is nullary and reads `activeArticle` from module
 * scope — the agent owns its own session state without a shell-shaped
 * context object.
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description: "Obsidian reading guide",
	colorKey: "secondary",
	extraTools: [editTool, writeTool],
	buildInstructions: () => buildReaderInstructions(activeArticle),
	commands: [articleCommand],
};
