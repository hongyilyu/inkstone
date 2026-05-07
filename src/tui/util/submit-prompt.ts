/**
 * Pure prompt-submission decision layer.
 *
 * Extracted from `prompt.tsx`'s `handleSubmit` so the slash-vs-plain
 * dispatch rule, mention expansion into slash args, and the plain-
 * prompt mention payload all live in one testable place.
 *
 * Input: the raw textarea contents + extracted mentions + seams for
 * slash dispatch and vault-file reads.
 *
 * Output: a discriminated union the caller translates into renderable
 * effects (`clearInput`, `actions.prompt`, `toast.show`).
 *
 * Slash semantics (mirrors the pre-refactor inline logic):
 *   - Raw text must start with `/`. Leading whitespace → plain prompt.
 *   - Split on the first space: `/name args...`.
 *   - Mentions inside the args range are expanded to their vault-
 *     absolute paths via `expandMentionsToPaths` before dispatch.
 *   - `triggerSlash(name, args)` decides whether the entry exists and
 *     runs; returns true when it fired. `false` falls through to the
 *     plain-prompt path.
 *
 * Plain-prompt path: runs `buildMentionPayload` to produce both the
 * LLM-facing text (with `Path:`/`Content:` blocks for successful
 * reads) and the user-bubble `DisplayPart[]`.
 *
 * `noop` is returned for empty/whitespace-only input — the caller
 * should early-return and NOT clear the input.
 */

import type { DisplayPart } from "@bridge/view-model";
import {
	buildMentionPayload,
	expandMentionsToPaths,
	type Mention,
} from "./mentions";

export type Submission =
	| { kind: "noop" }
	| { kind: "dispatched" }
	| {
			kind: "prompt";
			llmText: string;
			displayParts: DisplayPart[];
			failed: string[];
	  };

export interface SubmissionDeps {
	/** Dispatcher returning true if a registered slash entry fired. */
	triggerSlash: (name: string, args: string) => boolean;
	/** Reader used for plain-prompt mention expansion. Returns null on read failure. */
	readFile: (absPath: string) => string | null;
}

export function buildSubmission(
	rawText: string,
	mentions: Mention[],
	deps: SubmissionDeps,
): Submission {
	if (rawText.trim().length === 0) return { kind: "noop" };

	// Strict start-of-buffer gate: a leading whitespace buffer like
	// `  /clear` falls through as a plain prompt. Matches the dropdown's
	// open rule and the coaching-hint memo, so open/dispatch/hint agree.
	if (rawText.startsWith("/")) {
		const spaceAt = rawText.indexOf(" ");
		const name =
			spaceAt === -1 ? rawText.slice(1).trim() : rawText.slice(1, spaceAt);
		const args = spaceAt === -1 ? "" : expandArgs(rawText, spaceAt, mentions);
		if (deps.triggerSlash(name, args)) return { kind: "dispatched" };
	}

	const { llmText, displayParts, failed } = buildMentionPayload(
		rawText,
		mentions,
		deps.readFile,
	);
	return { kind: "prompt", llmText, displayParts, failed };
}

function expandArgs(
	rawText: string,
	spaceAt: number,
	mentions: Mention[],
): string {
	const argsStart = spaceAt + 1;
	const argsText = rawText.slice(argsStart);
	// Rebase mention offsets into the args slice's coordinate space.
	// Mentions entirely before the first space (inside the verb `/name`)
	// stay as literal text and — if any — would mangle the verb so
	// `canRunSlash` rejects; that path lands on the plain-prompt
	// fallback, which is the intended behavior.
	const argsMentions = mentions
		.filter((m) => m.start >= argsStart)
		.map((m) => ({
			start: m.start - argsStart,
			end: m.end - argsStart,
			path: m.path,
		}));
	return expandMentionsToPaths(argsText, argsMentions).trim();
}
