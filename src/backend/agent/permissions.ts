import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type {
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@mariozechner/pi-agent-core";
import { VAULT_DIR } from "./constants";

/**
 * Declarative permission rules. Evaluated in order by `dispatchBeforeToolCall`;
 * the first rule that returns `{ block, reason }` short-circuits.
 *
 * All current rule kinds are path-keyed (they read `args.path`). Tools
 * without a `path` arg (none today) would pass through untouched.
 *
 * Adding a rule kind:
 *   1. Add a variant to the `Rule` union below.
 *   2. Handle it in `evaluateRule` (the switch).
 *   3. Update `docs/ARCHITECTURE.md` Guard Logic if the rule has
 *      user-visible semantics.
 */
export type Rule =
	/** Path must resolve inside ANY listed dir. Multiple `insideDirs` rules
	 *  are AND-joined (each must pass) — use a single rule with multiple
	 *  dirs for OR semantics. */
	| { kind: "insideDirs"; dirs: string[] }
	/** If the resolved path is inside any listed dir, ask the user via the
	 *  injected `confirmFn`. Decline → block. */
	| { kind: "confirmDirs"; dirs: string[] }
	/** Block when the resolved path equals `path`. Used for "cannot
	 *  overwrite this specific file" rules. */
	| { kind: "blockPath"; path: string; reason: string }
	/** On tools with an `edits` array (pi-coding-agent's `edit`), every
	 *  `edits[].oldText` must fall inside the frontmatter of `targetPath`
	 *  when the resolved args.path matches `targetPath`. Used by reader to
	 *  permit frontmatter edits on the active article while blocking body
	 *  edits. */
	| { kind: "frontmatterOnlyFor"; targetPath: string };

/**
 * Agent-scoped rule overlay, keyed by tool name. Merged AFTER the tool's
 * baseline at evaluation time (`[...baseline, ...overlay[toolName]]`).
 */
export type AgentOverlay = Partial<Record<string, Rule[]>>;

/**
 * Baseline rules per tool, populated at module-load by `tools.ts`. The
 * dispatcher reads this when a tool fires. Tools without an entry here
 * run unsandboxed (matches pi-coding-agent's own default) — by
 * convention every tool Inkstone composes into `BASE_TOOLS` or
 * `extraTools` registers its baseline.
 */
const baselineRules: Record<string, Rule[]> = {};

export function registerBaseline(toolName: string, rules: Rule[]): void {
	baselineRules[toolName] = rules;
}

/**
 * Confirmation-dialog injection. The TUI wires this at boot via
 * `@backend/agent`'s re-export. Guards referencing `confirmDirs` call
 * the stored function; if unset (e.g. pre-boot, or a headless runner),
 * the confirm is skipped — safe because the path already passed
 * `insideDirs`.
 */
let confirmFn: ((title: string, message: string) => Promise<boolean>) | null =
	null;

export function setConfirmFn(
	fn: (title: string, message: string) => Promise<boolean>,
): void {
	confirmFn = fn;
}

/**
 * Resolve the LLM-supplied path to the absolute path pi-coding-agent's
 * tool will actually touch. Mirrors `expandPath` + `resolveToCwd` from
 * `@mariozechner/pi-coding-agent/dist/core/tools/path-utils` (not a
 * public subpath — see `docs/ARCHITECTURE.md` Guard Logic for why we
 * inline the subset). The sandbox check is only meaningful if it runs
 * against the same bytes the tool ends up resolving to.
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

function getFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) return null;
	const close = content.indexOf("\n---", 3);
	if (close === -1) return null;
	return content.slice(0, close + 4);
}

/**
 * Prefix-safe check for "is `child` inside `dir`?". Uses `path.sep` as a
 * boundary so `.../LifeOS` doesn't match `.../LifeOS-backup/x`. Equality
 * (`child === dir`) counts as inside — a tool call against the directory
 * itself is covered by the same rule as a file inside it.
 */
function isInsideDir(child: string, dir: string): boolean {
	if (child === dir) return true;
	const prefix = dir.endsWith(sep) ? dir : dir + sep;
	return child.startsWith(prefix);
}

/**
 * Evaluate one rule against the current tool call. Returns `{ block,
 * reason }` to veto execution, `undefined` to pass. Async because
 * `confirmDirs` may await a user dialog.
 */
async function evaluateRule(
	rule: Rule,
	args: Record<string, unknown>,
): Promise<BeforeToolCallResult | undefined> {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	const resolvedPath = rawPath !== undefined ? resolvePath(rawPath) : undefined;

	switch (rule.kind) {
		case "insideDirs": {
			if (resolvedPath === undefined) return undefined;
			if (!rule.dirs.some((d) => isInsideDir(resolvedPath, d))) {
				return {
					block: true,
					reason:
						rule.dirs.length === 1
							? `Path must be within ${rule.dirs[0]}`
							: `Path must be within one of: ${rule.dirs.join(", ")}`,
				};
			}
			return undefined;
		}
		case "confirmDirs": {
			if (resolvedPath === undefined) return undefined;
			if (!rule.dirs.some((d) => isInsideDir(resolvedPath, d)))
				return undefined;
			if (!confirmFn) return undefined;
			const ok = await confirmFn(
				"Write confirmation",
				`Allow write to ${resolvedPath}?`,
			);
			if (!ok) return { block: true, reason: "User declined." };
			return undefined;
		}
		case "blockPath": {
			if (resolvedPath === rule.path) {
				return { block: true, reason: rule.reason };
			}
			return undefined;
		}
		case "frontmatterOnlyFor": {
			if (resolvedPath !== rule.targetPath) return undefined;
			if (!existsSync(rule.targetPath)) return undefined;
			const content = readFileSync(rule.targetPath, "utf-8");
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
			return undefined;
		}
	}
}

/**
 * The `beforeToolCall` hook Inkstone registers on pi-agent-core's Agent.
 * Pulls the active tool's baseline rules and the active agent's overlay
 * (if any), concatenates, evaluates in order, short-circuits on first
 * block.
 *
 * Rule order:
 *   [...registerBaseline(toolName), ...overlay[toolName]]
 *
 * So agent overlays run AFTER baselines — they can add restrictions but
 * can't relax them. No tool today registers a "permissive" baseline
 * that an overlay would want to tighten; if that situation arises, the
 * agent owns whichever tool variant it exposes in `extraTools`.
 */
export async function dispatchBeforeToolCall(
	ctx: BeforeToolCallContext,
	overlay?: AgentOverlay,
): Promise<BeforeToolCallResult | undefined> {
	const toolName = ctx.toolCall.name;
	const args = ctx.args as Record<string, unknown>;

	const rules: Rule[] = [
		...(baselineRules[toolName] ?? []),
		...(overlay?.[toolName] ?? []),
	];

	for (const rule of rules) {
		const result = await evaluateRule(rule, args);
		if (result?.block) return result;
	}

	return undefined;
}
