import { resolve } from "node:path";
import type { AgentCommand, AgentInfo, AgentZone } from "../../base";
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
 * article via the shell-provided context method (which also mirrors
 * the value into the store and persists it to the session row), then
 * kicks off an LLM turn asking the agent to start the reading
 * workflow. The shell's `AgentActions.prompt` wrapper rebuilds the
 * system prompt at the turn boundary, so `buildInstructions()` reads
 * the freshly-set `activeArticle` automatically.
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
		ctx.setActiveArticle(articleId);
		await ctx.prompt(`Read ${articleId}`);
	},
};

/**
 * Reader's workspace — three zones, all confirm-before-write. Articles
 * live in `010 RAW/013 Articles/` and reader may only touch their
 * frontmatter (enforced by the `frontmatterOnlyFor` rule in the
 * overlay below; zones just gate the directory). Scraps and Notes are
 * the two preservation destinations Stage 5 writes to.
 *
 * Declared as vault-relative paths; the composer resolves them against
 * `VAULT_DIR` at overlay-build time. These mirror the absolute
 * constants in `../../constants.ts` — the duplication is the cost of
 * zones being declarative data rather than a function call. Worth it
 * for the LLM-visibility half (the `<your workspace>` prompt block).
 */
const readerZones: AgentZone[] = [
	{ path: "010 RAW/013 Articles", write: "confirm" },
	{ path: "020 HUMAN/022 Scraps", write: "confirm" },
	{ path: "020 HUMAN/023 Notes", write: "confirm" },
];

/**
 * Reader's permission overlay — only the article-specific rules that
 * zones can't express. Directory-level confirm rules are derived from
 * `readerZones` by `composeZonesOverlay` (see `../../base.ts`), so
 * this overlay is the escape hatch for state-dependent policies:
 *
 * - `write` on the active article is blocked outright (frontmatter
 *   changes must go through `edit`, never a full overwrite).
 * - `edit` on the active article is restricted to frontmatter hunks
 *   via the `frontmatterOnlyFor` rule.
 *
 * Rules are freshly constructed each call so the article path is
 * always current for the active article. Non-article paths aren't
 * matched by either rule (`blockPath` is equality, `frontmatterOnlyFor`
 * is keyed on `targetPath`).
 *
 * Returns an empty overlay when no article is active — reader has no
 * article-specific policy until `/article <filename>` kicks the
 * workflow off.
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
	zones: readerZones,
	buildInstructions: () => buildReaderInstructions(activeArticle),
	commands: [articleCommand],
	getPermissions: getReaderPermissions,
};
