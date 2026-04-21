import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@mariozechner/pi-agent-core";
import { NOTES_DIR, SCRAPS_DIR, VAULT_DIR } from "./constants";

/** Injected by AgentProvider -- shows a confirmation dialog and returns user's choice */
let confirmFn: ((title: string, message: string) => Promise<boolean>) | null =
	null;

export function setConfirmFn(
	fn: (title: string, message: string) => Promise<boolean>,
) {
	confirmFn = fn;
}

function getFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) return null;
	const close = content.indexOf("\n---", 3);
	if (close === -1) return null;
	return content.slice(0, close + 4);
}

function resolvePath(p: string): string {
	if (p.startsWith("/")) return resolve(p);
	return resolve(VAULT_DIR, p);
}

export async function beforeToolCall(
	ctx: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
	const toolName = ctx.toolCall.name;
	const args = ctx.args as Record<string, any>;

	// Only guard file tools
	if (
		toolName !== "read_file" &&
		toolName !== "edit_file" &&
		toolName !== "write_file"
	) {
		return undefined;
	}

	const targetPath = resolvePath(args.path);

	// Block anything outside VAULT_DIR
	if (!targetPath.startsWith(VAULT_DIR)) {
		return { block: true, reason: `Path must be within ${VAULT_DIR}` };
	}

	// Find the active article path (if any)
	const articlePath = args._articlePath as string | undefined;

	// Guard article file
	if (articlePath && targetPath === articlePath) {
		// Block full writes to article file
		if (toolName === "write_file") {
			return {
				block: true,
				reason:
					"Cannot overwrite the article file. Use edit_file to modify frontmatter only.",
			};
		}

		// Allow frontmatter edits, block content edits
		if (toolName === "edit_file") {
			if (!existsSync(articlePath)) return undefined;

			const content = readFileSync(articlePath, "utf-8");
			const frontmatter = getFrontmatter(content);

			if (!frontmatter?.includes(args.oldText)) {
				return {
					block: true,
					reason:
						"Only frontmatter modifications are allowed on the article file.",
				};
			}
		}

		return undefined;
	}

	// Confirm writes to notes/scraps dirs
	if (toolName === "write_file" || toolName === "edit_file") {
		if (targetPath.startsWith(NOTES_DIR) || targetPath.startsWith(SCRAPS_DIR)) {
			if (confirmFn) {
				const ok = await confirmFn(
					"Write confirmation",
					`Allow write to ${targetPath}?`,
				);
				if (!ok) return { block: true, reason: "User declined." };
			}
		}
	}

	return undefined;
}
