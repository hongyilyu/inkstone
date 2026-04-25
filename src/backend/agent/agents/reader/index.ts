import type { AgentInfo } from "../../base";
import { buildReaderInstructions } from "./instructions";
import { editFileTool } from "./tools/edit-file";
import { quoteArticleTool } from "./tools/quote-article";
import { writeFileTool } from "./tools/write-file";

/**
 * Reader — the Obsidian reading guide. Walks the user through the
 * 6-stage reading workflow (see `./instructions.ts`) and manages
 * article frontmatter edits, scraps, and notes inside the vault.
 *
 * Tools: `read_file` comes from `BASE_TOOLS`; the three write/search
 * tools below are reader-specific and live next to this agent's
 * folder.
 *
 * extraTools order is `[edit_file, write_file, quote_article]` so that
 * after `BASE_TOOLS` (`[read_file]`) is prepended by `composeTools`,
 * the final declaration order matches the pre-refactor shape
 * (`[read_file, edit_file, write_file, quote_article]`). Keeping the
 * byte-for-byte tool prefix stable preserves provider prompt-cache
 * hits across the refactor boundary.
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description: "Obsidian reading guide",
	colorKey: "secondary",
	extraTools: [editFileTool, writeFileTool, quoteArticleTool],
	buildInstructions: (ctx) => buildReaderInstructions(ctx.activeArticle),
};

/**
 * Re-export of the reader's module-level `activeArticle` setter so the
 * agent shell (`backend/agent/index.ts`) can route `loadArticle` /
 * `clearSession` through the reader's public entry point rather than
 * reaching into `./tools/quote-article` directly. Reader-specific
 * session state stays colocated with the reader agent; the shell only
 * needs to know the agent exists.
 *
 * This is a scaffold for the proper fix — per-agent session actions
 * registered via `AgentInfo.sessionActions` — which is tracked as
 * future work in `docs/TODO.md`.
 */
export { setActiveArticle } from "./tools/quote-article";
