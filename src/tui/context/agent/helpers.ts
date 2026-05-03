/**
 * Pure helpers used by the reducer + actions. No closure over provider
 * state; safe to import from any submodule.
 */

/**
 * Placeholder strings that providers inject into redacted thinking blocks.
 * When a `thinking_end` arrives and the accumulated text consists solely of
 * one of these placeholders (possibly with surrounding whitespace), the
 * thinking part is dropped from the message — it carries no user-visible
 * information and would otherwise persist as a dead breadcrumb.
 *
 * - `[REDACTED]`                    — OpenRouter literal (all providers)
 * - `Reasoning hidden by provider`  — pi-kiro slow-path marker (conformance §26a)
 */
export const REDACTED_THINKING_PLACEHOLDERS = [
	"[REDACTED]",
	"Reasoning hidden by provider",
] as const;

/**
 * Pull a short error line out of a failed tool result. pi-agent-core
 * wraps tool execution in a try/catch and constructs an error-shaped
 * result — `content[0].text` holds the Error message. Falls through to
 * `undefined` so the renderer shows a generic error state.
 *
 * Success results are deliberately not summarized: today's tools
 * (`read`/`edit`/`write`/`update_sidebar`) all carry their user-visible
 * information in the args, so a second "result" line would just restate
 * what the header already said. If a future tool's result carries info
 * the args don't (e.g. `grep` match count), reintroduce a summary path.
 */
export function extractErrorMessage(result: any): string | undefined {
	if (!result) return undefined;
	const first = Array.isArray(result.content) ? result.content[0] : undefined;
	if (first && first.type === "text" && typeof first.text === "string") {
		return trimOneLine(first.text);
	}
	return undefined;
}

export function trimOneLine(s: string, limit = 120): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, limit - 1)}…`;
}
