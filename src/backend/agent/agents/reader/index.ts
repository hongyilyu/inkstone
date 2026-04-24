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
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description: "Obsidian reading guide",
	colorKey: "secondary",
	extraTools: [quoteArticleTool, editFileTool, writeFileTool],
	buildInstructions: (ctx) => buildReaderInstructions(ctx.activeArticle),
};
