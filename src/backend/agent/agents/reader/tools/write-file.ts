import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { VAULT_DIR } from "../../../constants";

const Parameters = Type.Object({
	path: Type.String({
		description: "Absolute or vault-relative path to the file to write",
	}),
	content: Type.String({ description: "The content to write" }),
	append: Type.Optional(
		Type.Boolean({
			description: "Append to file instead of overwriting. Default: false",
		}),
	),
});

export const writeFileTool: AgentTool<typeof Parameters> = {
	name: "write_file",
	label: "Write File",
	description:
		"Write or append content to a file. Creates parent directories if needed. Path must be within the vault directory.",
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

		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		if (params.append) {
			appendFileSync(filePath, params.content, "utf-8");
		} else {
			writeFileSync(filePath, params.content, "utf-8");
		}

		const action = params.append ? "Appended to" : "Wrote";
		return {
			content: [{ type: "text", text: `${action} ${filePath}` }],
			details: { path: filePath, action: params.append ? "append" : "write" },
		};
	},
};

function resolvePath(p: string): string {
	if (p.startsWith("/")) return resolve(p);
	return resolve(VAULT_DIR, p);
}
