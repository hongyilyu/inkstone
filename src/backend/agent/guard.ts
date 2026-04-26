import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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

/**
 * Resolve the LLM-supplied path to the absolute path the tool will
 * actually touch on disk. The guard's `startsWith(VAULT_DIR)` sandbox
 * check is only meaningful if it operates on the same string the tool
 * writes to.
 *
 * pi-coding-agent's read/write/edit tools resolve paths by:
 *   - stripping a leading `@` (rarely seen in practice)
 *   - expanding `~` / `~/` against `$HOME`
 *   - resolving the result against the tool's `cwd` (here, `VAULT_DIR`)
 *     when still relative, or returning it as-is when absolute.
 *
 * If we skipped any of that, a path like `~/foo` would land outside
 * `VAULT_DIR` on disk but pass the sandbox check (because the literal
 * `~/foo` joined to VAULT_DIR stays inside). Same for `@/etc/shadow`.
 * Both bypasses are cheap and we mirror the behavior exactly.
 *
 * Unicode-space normalization (which pi-coding-agent also does) is
 * omitted; a path with exotic spaces would fail `startsWith(VAULT_DIR)`
 * and get blocked — less ergonomic than the tool for no security cost.
 */
function resolvePath(p: string): string {
	const stripped = p.startsWith("@") ? p.slice(1) : p;
	let expanded: string;
	if (stripped === "~") {
		expanded = homedir();
	} else if (stripped.startsWith("~/")) {
		expanded = homedir() + stripped.slice(1);
	} else {
		expanded = stripped;
	}
	return isAbsolute(expanded)
		? resolve(expanded)
		: resolve(VAULT_DIR, expanded);
}

export async function beforeToolCall(
	ctx: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
	const toolName = ctx.toolCall.name;
	const args = ctx.args as Record<string, any>;

	// Only guard file tools
	if (toolName !== "read" && toolName !== "edit" && toolName !== "write") {
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
		if (toolName === "write") {
			return {
				block: true,
				reason:
					"Cannot overwrite the article file. Use edit to modify frontmatter only.",
			};
		}

		// Allow frontmatter edits, block content edits. pi-coding-agent's
		// edit schema is `{ path, edits: [{ oldText, newText }, ...] }` —
		// every entry must target frontmatter, not just the first.
		if (toolName === "edit") {
			if (!existsSync(articlePath)) return undefined;

			const content = readFileSync(articlePath, "utf-8");
			const frontmatter = getFrontmatter(content);
			const edits = (args.edits ?? []) as Array<{ oldText?: string }>;

			for (const edit of edits) {
				if (typeof edit?.oldText !== "string") continue;
				if (!frontmatter?.includes(edit.oldText)) {
					return {
						block: true,
						reason:
							"Only frontmatter modifications are allowed on the article file.",
					};
				}
			}
		}

		return undefined;
	}

	// Confirm writes to notes/scraps dirs
	if (toolName === "write" || toolName === "edit") {
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
