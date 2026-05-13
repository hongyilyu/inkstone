/**
 * LLM-generated session-title task — shared kickoff for every "first
 * user message becomes a real session" site. Two callers today:
 * `promptAction` (plain-chat first message) and the routing seam's
 * `agent_end` macrotask (router-routed child sessions). Adding a third
 * caller is a one-line `scheduleSessionTitleTask(...)`.
 */

import type { generateSessionTitle } from "@backend/agent";
import { logger } from "@backend/logger";
import { persist, updateSessionTitle } from "@backend/persistence/sessions";
import type { AgentStoreState, DisplayPart } from "@bridge/view-model";
import type { SetStoreFunction } from "solid-js/store";

const log = logger.child("tui.title-task");

export interface SessionTitleTaskDeps {
	titleGenerator: typeof generateSessionTitle;
	getCurrentSessionId: () => string | null;
	setStore: SetStoreFunction<AgentStoreState>;
}

export interface ScheduleSessionTitleTaskParams {
	sessionId: string;
	activeProviderId: string;
	activeModelId: string;
	/** Post-`buildTitlePrompt` LLM input. */
	prompt: string;
}

/**
 * Fire-and-forget. The DB write goes ahead unconditionally; the
 * `getCurrentSessionId() === sessionId` guard scopes the in-store
 * mirror so a session-swap between scheduling and resolution doesn't
 * paint a stale title onto the new active session. Documented
 * asymmetry — see `docs/TODO.md` Known Issues.
 */
export function scheduleSessionTitleTask(
	params: ScheduleSessionTitleTaskParams,
	deps: SessionTitleTaskDeps,
): void {
	void deps
		.titleGenerator(params)
		.then((title) => {
			if (!title) return;
			persist((tx) => updateSessionTitle(tx, params.sessionId, title), {
				onSuccess: () => {
					if (deps.getCurrentSessionId() === params.sessionId) {
						deps.setStore("sessionTitle", title);
					}
				},
			});
		})
		.catch((error) => {
			// `generateSessionTitle` swallows + logs `completeSimple`
			// throws on both primary and retry. Anything reaching here
			// is from the orchestration layer (`getApiKey()` /
			// `loadConfig()`) — log enough context to debug.
			log.warn(
				"task failed",
				error instanceof Error ? error : new Error(String(error)),
			);
			log.debug("active model context", {
				providerId: params.activeProviderId,
				modelId: params.activeModelId,
			});
		});
}

/**
 * Flatten the user-facing display shape (typed text + optional file
 * chips from `@`-mentions or reader's `/article`) into a short
 * "text + filename-stem" string for the title model. Without this,
 * `@`-mention prompts feed the LLM their `Path: + body` packed text
 * truncated at 4 KB, drowning the actual question.
 */
export function buildTitlePrompt(
	text: string,
	displayParts: DisplayPart[] | undefined,
): string {
	if (!displayParts) return text;
	const pieces: string[] = [];
	for (const part of displayParts) {
		if (part.type === "text") {
			const t = part.text.trim();
			if (t) pieces.push(t);
		} else if (part.type === "file") {
			const stem = filenameStem(part.filename);
			if (stem) pieces.push(stem);
		}
	}
	const joined = pieces.join(" ").trim();
	return joined || text;
}

function filenameStem(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const base = slash === -1 ? path : path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? base : base.slice(0, dot);
}
