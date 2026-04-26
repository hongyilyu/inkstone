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
 * Inlined subset of pi-coding-agent's `expandPath` + `resolveToCwd`
 * (`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js`).
 *
 * The guard MUST resolve paths the same way the tool does. If the model
 * sends `~/foo` and the guard used `resolve(VAULT_DIR, ...)` with the
 * literal `~`, it would see `{VAULT_DIR}/~/foo` (passes the sandbox
 * check) while the tool expands `~` and writes to `{HOME}/foo` (escapes
 * the sandbox). Same bypass for the `@` prefix pi-coding-agent strips.
 *
 * We replicate rather than import because pi-coding-agent's
 * `package.json` `exports` field only exposes the package root and a
 * (currently-empty) `./hooks` entry — `core/tools/path-utils` is not
 * reachable as a public subpath, and bun enforces the `exports` map at
 * runtime (deep imports throw `Cannot find module` even when tsc is
 * happy). The cost is ~10 lines; upstream refactors of path-utils stay
 * our problem to notice.
 *
 * Unicode-space normalization is omitted — a path with exotic spaces
 * would simply fail `startsWith(VAULT_DIR)` and get blocked, which is
 * safe (just a UX miss, not a security gap).
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
