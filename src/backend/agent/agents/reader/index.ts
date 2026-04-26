import { resolve } from "node:path";
import type { AgentCommand, AgentInfo } from "../../base";
import { ARTICLES_DIR } from "../../constants";
import type { AgentOverlay } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import { buildReaderInstructions } from "./instructions";

/**
 * Reader's session state — the currently-open article, if any. Reader
 * owns this rather than the shell (`backend/agent/index.ts`) because
 * it's reader-specific vocabulary, not a generic shell concept. The
 * shell reads via `getActiveArticle()` for session restore/clear, and
 * reader's own `getPermissions()` (below) reads it to inline the
 * article's absolute path into the permission overlay for each turn.
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
 * article, then kicks off an LLM turn asking the agent to start the
 * reading workflow. The shell's `AgentActions.prompt` wrapper rebuilds
 * the system prompt at the turn boundary, so `buildInstructions()`
 * reads the freshly-set `activeArticle` automatically.
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
		await ctx.prompt(`Read ${articleId}`);
	},
};

/**
 * Reader's permission overlay — layers on top of the tool baselines
 * declared in `backend/agent/tools.ts` (`insideDirs: [VAULT_DIR]`,
 * `confirmDirs: [NOTES_DIR, SCRAPS_DIR]`). Called by the permission
 * dispatcher once per tool call; rule objects are freshly constructed
 * each call so the article's absolute path is always current.
 *
 * - `write`: block overwriting the active article file (frontmatter
 *   edits still flow through `edit` below).
 * - `edit`: on the active article file, every edit's `oldText` must
 *   fall inside the frontmatter block. Non-article paths skip this
 *   rule (matched by `targetPath` equality inside the dispatcher).
 *
 * Returns an empty overlay when no article is active — the 6-stage
 * workflow starts at `/article <filename>`, so until that happens the
 * agent has no article-specific policy.
 */
function getReaderPermissions(): AgentOverlay {
	if (!activeArticle) return {};
	const articlePath = resolve(ARTICLES_DIR, activeArticle);
	return {
		[writeTool.name]: [
			{
				kind: "blockPath",
				path: articlePath,
				reason:
					"Cannot overwrite the article file. Use edit to modify frontmatter only.",
			},
		],
		[editTool.name]: [{ kind: "frontmatterOnlyFor", targetPath: articlePath }],
	};
}

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
	getPermissions: getReaderPermissions,
};
