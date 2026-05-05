import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type {
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@mariozechner/pi-agent-core";
import { createTwoFilesPatch } from "diff";
import { VAULT_DIR } from "./constants";

/**
 * Declarative permission rules evaluated by `dispatchBeforeToolCall`.
 * First-block-wins; all current rule kinds are path-keyed (they read
 * `args.path`). See `docs/ARCHITECTURE.md` § Permission Dispatcher for
 * the pipeline, rule-kinds table, and the "Adding a rule kind" recipe.
 */
export type Rule =
	/** Path must resolve inside ANY listed dir. Multiple `insideDirs` rules
	 *  are AND-joined (each must pass) — use a single rule with multiple
	 *  dirs for OR semantics. */
	| { kind: "insideDirs"; dirs: string[] }
	/** If the resolved path is inside any listed dir, ask the user via the
	 *  injected `confirmFn`. Decline → block. */
	| { kind: "confirmDirs"; dirs: string[] }
	/** Block when the resolved path is inside any listed dir (prefix match
	 *  with path-separator boundary). Used for "this whole directory tree
	 *  is read-only for this agent" rules. */
	| { kind: "blockInsideDirs"; dirs: string[]; reason: string }
	/** On tools with an `edits` array (pi-coding-agent's `edit`), when the
	 *  resolved `args.path` is inside any listed dir, every
	 *  `edits[].oldText` must fall inside the file's `---`-delimited
	 *  frontmatter. Used by reader to enforce "only frontmatter edits on
	 *  files inside Articles." */
	| { kind: "frontmatterOnlyInDirs"; dirs: string[] };

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
 * Optional diff preview attached to a `ConfirmRequest`. Populated only
 * for `confirmDirs` evaluations against write/edit tools where we can
 * compute the proposed `newText` cheaply from `args`. Consumers render
 * the `unifiedDiff` via OpenTUI's `<diff>` renderable; `oldText` /
 * `newText` are exposed for callers that want to render their own view.
 *
 * `unifiedDiff` is already the full unified-diff string (result of
 * `createTwoFilesPatch`), so consumers don't need to re-run the diff
 * library. Empty when old and new texts are identical — the UI should
 * treat absence and empty-string as "no change to show."
 */
export interface ConfirmRequestPreview {
	filepath: string;
	oldText: string;
	newText: string;
	unifiedDiff: string;
}

/**
 * Structured payload passed to the injected `confirmFn`. `callId`
 * lets consumers correlate the approval with the pi-agent-core tool
 * call that triggered it (same id the reducer sees on
 * `toolcall_end` / `tool_execution_end`); the TUI uses it to key
 * its diff-preview registry so `ToolPart` can render the unified
 * diff inline above the approval panel. `preview` is optional:
 * confirm-dir approvals for non-write tools (or writes where we
 * can't cheaply reconstruct `newText`) omit it.
 */
export interface ConfirmRequest {
	callId: string;
	title: string;
	message: string;
	preview?: ConfirmRequestPreview;
}

/**
 * Confirmation-dialog injection. The TUI wires this at boot via
 * `@backend/agent`'s re-export. When unset, `confirmDirs` rules
 * **block by default** rather than falling through — headless callers
 * (tests, future scripting) must explicitly opt in to auto-allow by
 * calling `setConfirmFn(async () => true)` before dispatching tool
 * calls. Fail-closed is the right default now that D12 moved
 * directory-level confirmation entirely onto zones: skipping the
 * confirm would silently bypass the user's declared policy, not just
 * a redundant gate.
 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;

let confirmFn: ConfirmFn | null = null;

export function setConfirmFn(fn: ConfirmFn | null): void {
	confirmFn = fn;
}

/**
 * Return the currently-installed confirm fn (or null). Exposed so the
 * TUI provider can capture the pre-install value and restore it on
 * unmount — prevents a disposed provider's closure from surviving a
 * re-mount in tests / future HMR.
 */
export function getConfirmFn(): ConfirmFn | null {
	return confirmFn;
}

/**
 * Resolve the LLM-supplied path to the absolute path pi-coding-agent's
 * tool will actually touch. Mirrors `expandPath` + `resolveToCwd` from
 * `@mariozechner/pi-coding-agent/dist/core/tools/path-utils` (not
 * exposed through the package's `exports` map, so we can't deep-import).
 * The sandbox check is only meaningful if it runs against the same
 * bytes the tool ends up resolving to.
 *
 * Byte-equality invariant: match every step pi-coding-agent performs
 * before it calls `fs.readFileSync` / `fs.writeFileSync`. Upstream
 * `expandPath` runs `@`-strip first, THEN Unicode-space normalize, then
 * `~` expansion, then `resolveToCwd` joins against cwd. Inkstone
 * mirrors the same order. (The `@`-vs-normalize step order doesn't
 * matter for correctness — `@` is ASCII, disjoint from every codepoint
 * in `UNICODE_SPACES` — but matching upstream's sequence keeps the
 * docstring honest.)
 *
 * Not mirrored: `resolveReadPath`'s macOS NFD / curly-quote / AM-PM
 * variant-hunt (pi-coding-agent's `path-utils.js:54-80`). That's only
 * meaningful for agent-authored filenames on macOS; Inkstone's vault
 * is user-owned, so mirroring it would expand the sandbox surface
 * without closing a real hole.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(s: string): string {
	return s.replace(UNICODE_SPACES, " ");
}

function resolvePath(p: string): string {
	const stripped = p.startsWith("@") ? p.slice(1) : p;
	const normalized = normalizeUnicodeSpaces(stripped);
	let expanded: string;
	if (normalized === "~") {
		expanded = homedir();
	} else if (normalized.startsWith("~/")) {
		expanded = homedir() + normalized.slice(1);
	} else {
		expanded = normalized;
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
 *
 * Exported for agent-internal callers (e.g. reader's `/article` escape
 * check) so "inside a directory" has one implementation across the
 * backend. The prefix-string-match spelling leaks; use this instead of
 * `startsWith(dir + "/")` anywhere the boundary matters.
 */
export function isInsideDir(child: string, dir: string): boolean {
	if (child === dir) return true;
	const prefix = dir.endsWith(sep) ? dir : dir + sep;
	return child.startsWith(prefix);
}

/**
 * Build a `ConfirmRequestPreview` for a `confirmDirs` approval when
 * the tool shape makes `newText` cheap to compute. Returns `undefined`
 * when we can't produce a faithful preview — callers treat absence as
 * "no diff available, show title + message only."
 *
 * The apply here is deliberately literal (`indexOf` + slice-replace,
 * applied right-to-left so earlier edits don't shift later match
 * positions), not pi-coding-agent's fuzzy match. Rationale: the
 * preview is advisory — it tells the user roughly what will change so
 * they can decide whether to approve. If the literal apply can't find
 * a match, the tool's fuzzy logic might still succeed (or fail), and
 * either way we'd rather show no preview than a misleading one. A
 * future cross-package port of `applyEditsToNormalizedContent` could
 * tighten this.
 *
 * Inputs that skip preview:
 *   - Unknown tool name (not `write` / `edit`).
 *   - `edit` with any `edits[].oldText` not found verbatim in the
 *     file (most common cause: pi-coding-agent's fuzzy match would
 *     have succeeded; our literal match didn't).
 *   - `edit` with overlapping matches (we detect post-sort; bail out
 *     rather than produce garbage).
 *
 * The patch header uses the resolved filepath for both sides so the
 * `<diff>` renderable shows a sensible `--- <file> / +++ <file>`
 * header; we're diffing "before-state" vs "after-state" of one file,
 * not two files.
 */
function buildPreview(
	toolName: string,
	args: Record<string, unknown>,
	resolvedPath: string,
): ConfirmRequestPreview | undefined {
	const oldText = existsSync(resolvedPath)
		? readFileSync(resolvedPath, "utf-8")
		: "";
	let newText: string;

	if (toolName === "write") {
		const content = args.content;
		if (typeof content !== "string") return undefined;
		newText = content;
	} else if (toolName === "edit") {
		const edits = args.edits;
		if (!Array.isArray(edits)) return undefined;
		const applied = applyLiteralEdits(oldText, edits);
		if (applied === undefined) return undefined;
		newText = applied;
	} else {
		return undefined;
	}

	if (oldText === newText) {
		return { filepath: resolvedPath, oldText, newText, unifiedDiff: "" };
	}

	const unifiedDiff = createTwoFilesPatch(
		resolvedPath,
		resolvedPath,
		oldText,
		newText,
	);
	return { filepath: resolvedPath, oldText, newText, unifiedDiff };
}

/**
 * Literal-match apply for the `edit` tool's preview. Finds each
 * `oldText` via `indexOf` (no fuzzy, no normalization), rejects
 * overlapping matches after sort, applies right-to-left. Returns
 * `undefined` if any edit can't be matched or if overlapping matches
 * are detected.
 */
function applyLiteralEdits(
	source: string,
	edits: unknown[],
): string | undefined {
	type Match = { index: number; length: number; newText: string };
	const matches: Match[] = [];
	for (const raw of edits) {
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof (raw as Record<string, unknown>).oldText !== "string" ||
			typeof (raw as Record<string, unknown>).newText !== "string"
		) {
			return undefined;
		}
		const { oldText, newText } = raw as { oldText: string; newText: string };
		if (oldText.length === 0) return undefined;
		const index = source.indexOf(oldText);
		if (index === -1) return undefined;
		// Reject non-unique matches — matches pi-coding-agent's `edit`
		// semantics which throws on ambiguity. Preview that silently
		// picks the first occurrence could diverge from what the tool
		// would do.
		if (source.indexOf(oldText, index + 1) !== -1) return undefined;
		matches.push({ index, length: oldText.length, newText });
	}
	matches.sort((a, b) => a.index - b.index);
	for (let i = 1; i < matches.length; i++) {
		const prev = matches[i - 1];
		const cur = matches[i];
		if (prev && cur && prev.index + prev.length > cur.index) return undefined;
	}
	let out = source;
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		if (!m) continue;
		out = out.slice(0, m.index) + m.newText + out.slice(m.index + m.length);
	}
	return out;
}

/**
 * Evaluate one rule against the current tool call. Returns `{ block,
 * reason }` to veto execution, `undefined` to pass. Async because
 * `confirmDirs` may await a user dialog.
 */
async function evaluateRule(
	rule: Rule,
	ctx: BeforeToolCallContext,
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
			// Fail-closed when no UI is wired. Post-D12 this check owns the
			// user's declared per-zone confirm policy; silently passing would
			// bypass it in headless contexts. See `setConfirmFn` docstring.
			if (!confirmFn) {
				return {
					block: true,
					reason: "Confirmation required but no UI is wired.",
				};
			}
			const preview = buildPreview(ctx.toolCall.name, args, resolvedPath);
			const ok = await confirmFn({
				callId: ctx.toolCall.id,
				title: "Write confirmation",
				message: `Allow write to ${resolvedPath}?`,
				preview,
			});
			if (!ok) return { block: true, reason: "User declined." };
			return undefined;
		}
		case "blockInsideDirs": {
			if (resolvedPath === undefined) return undefined;
			if (rule.dirs.some((d) => isInsideDir(resolvedPath, d))) {
				return { block: true, reason: rule.reason };
			}
			return undefined;
		}
		case "frontmatterOnlyInDirs": {
			if (resolvedPath === undefined) return undefined;
			if (!rule.dirs.some((d) => isInsideDir(resolvedPath, d)))
				return undefined;
			if (!existsSync(resolvedPath)) return undefined;
			const content = readFileSync(resolvedPath, "utf-8");
			const frontmatter = getFrontmatter(content);
			const edits = (args.edits ?? []) as Array<{ oldText?: string }>;
			for (const edit of edits) {
				if (typeof edit?.oldText !== "string") continue;
				if (!frontmatter?.includes(edit.oldText)) {
					return {
						block: true,
						reason:
							"Only frontmatter modifications are allowed on files in this directory.",
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
		const result = await evaluateRule(rule, ctx, args);
		if (result?.block) return result;
	}

	return undefined;
}
