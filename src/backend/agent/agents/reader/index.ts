import type { AgentCommand, AgentInfo } from "../../base";
import { buildReaderInstructions } from "./instructions";
import { editFileTool } from "./tools/edit-file";
import {
	quoteArticleTool,
	setActiveArticle as setQuoteArticleActiveArticle,
} from "./tools/quote-article";
import { writeFileTool } from "./tools/write-file";

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

/**
 * Update the active article. Also propagates to `quote-article`'s
 * internal state — both stores track the same value; kept separate
 * historically because `quote_article` is a pi-agent-core `AgentTool`
 * and tools own their own state.
 */
export function setActiveArticle(id: string | null): void {
	activeArticle = id;
	setQuoteArticleActiveArticle(id);
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
 * Tools: `read_file` comes from `BASE_TOOLS`; the three write/search
 * tools below are reader-specific and live next to this agent's folder.
 *
 * extraTools order is `[edit_file, write_file, quote_article]` so that
 * after `BASE_TOOLS` (`[read_file]`) is prepended by `composeTools`,
 * the final declaration order is
 * `[read_file, edit_file, write_file, quote_article]` — byte-identical
 * to the pre-refactor shape for provider prompt-cache stability.
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
	extraTools: [editFileTool, writeFileTool, quoteArticleTool],
	buildInstructions: () => buildReaderInstructions(activeArticle),
	commands: [articleCommand],
};
