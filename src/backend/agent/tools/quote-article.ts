import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { ARTICLES_DIR } from "../constants";

const Parameters = Type.Object({
	query: Type.String({
		description:
			"Search query to match against article paragraphs (case-insensitive)",
	}),
});

let activeArticleId: string | null = null;

export function setActiveArticle(id: string | null) {
	activeArticleId = id;
}

export const quoteArticleTool: AgentTool<typeof Parameters> = {
	name: "quote_article",
	label: "Quote Article",
	description:
		"Search the active article for paragraphs matching a query. Use this to retrieve exact text when discussing specific claims or passages.",
	parameters: Parameters,

	async execute(_id, params): Promise<AgentToolResult<unknown>> {
		if (!activeArticleId) {
			return {
				content: [
					{
						type: "text",
						text: "No active article. Use /article <filename> to load one.",
					},
				],
				details: { error: true },
			};
		}

		const filePath = resolve(ARTICLES_DIR, activeArticleId);
		if (!existsSync(filePath)) {
			return {
				content: [{ type: "text", text: `Article not found: ${filePath}` }],
				details: { error: true },
			};
		}

		const content = readFileSync(filePath, "utf-8");
		const paragraphs = content.split(/\n\n+/);
		const query = params.query.toLowerCase();
		const matches = paragraphs.filter((p) => p.toLowerCase().includes(query));

		if (matches.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No matches for "${params.query}" in the article.`,
					},
				],
				details: { matchCount: 0 },
			};
		}

		return {
			content: [{ type: "text", text: matches.join("\n\n---\n\n") }],
			details: { matchCount: matches.length },
		};
	},
};
