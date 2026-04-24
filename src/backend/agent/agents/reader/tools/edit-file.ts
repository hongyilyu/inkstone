import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createTwoFilesPatch, diffLines } from "diff";
import { VAULT_DIR } from "../../../constants";

const Parameters = Type.Object({
	path: Type.String({
		description: "Absolute or vault-relative path to the file to edit",
	}),
	oldText: Type.String({ description: "The exact text to find and replace" }),
	newText: Type.String({ description: "The replacement text" }),
});

export const editFileTool: AgentTool<typeof Parameters> = {
	name: "edit_file",
	label: "Edit File",
	description:
		"Replace text in a file. Returns a unified diff. Path must be within the vault directory.",
	parameters: Parameters,

	async execute(_id, params): Promise<AgentToolResult<unknown>> {
		const filePath = resolvePath(params.path);

		if (!filePath.startsWith(VAULT_DIR)) {
			return {
				content: [
					{ type: "text", text: `Error: path must be within ${VAULT_DIR}` },
				],
				details: { error: true },
			};
		}

		if (!existsSync(filePath)) {
			return {
				content: [{ type: "text", text: `Error: file not found: ${filePath}` }],
				details: { error: true },
			};
		}

		const contentOld = readFileSync(filePath, "utf-8");

		if (!contentOld.includes(params.oldText)) {
			return {
				content: [
					{ type: "text", text: `Error: oldText not found in ${filePath}` },
				],
				details: { error: true },
			};
		}

		const contentNew = contentOld.replace(params.oldText, params.newText);
		writeFileSync(filePath, contentNew, "utf-8");

		const patch = createTwoFilesPatch(
			filePath,
			filePath,
			contentOld,
			contentNew,
		);

		let additions = 0;
		let deletions = 0;
		for (const change of diffLines(contentOld, contentNew)) {
			if (change.added) additions += change.count || 0;
			if (change.removed) deletions += change.count || 0;
		}

		return {
			content: [{ type: "text", text: patch }],
			details: { path: filePath, additions, deletions, diff: patch },
		};
	},
};

function resolvePath(p: string): string {
	if (p.startsWith("/")) return resolve(p);
	return resolve(VAULT_DIR, p);
}
