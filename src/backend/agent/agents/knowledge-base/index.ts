import type { AgentOverlay } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import type { AgentInfo, AgentZone } from "../../types";
import { KB_HUMAN_DIR, KB_RAW_DIR } from "./paths";

/**
 * Workspace zones — the LifeOS policy maps `040 FORGE/` to the agent's
 * default write surface and `090 SYSTEM/099 LLM Wiki/` to a confirm-
 * before-write zone (lint's tag-unification step touches
 * `tags-guidance.md` there). Read is vault-wide via `BASE_TOOLS`'
 * `readTool`; zones only constrain writes.
 */
const knowledgeBaseZones: AgentZone[] = [
	{ path: "040 FORGE", write: "auto" },
	{ path: "090 SYSTEM/099 LLM Wiki", write: "confirm" },
];

/**
 * Hard-block writes anywhere under `010 RAW/` and `020 HUMAN/` — the
 * LifeOS policy ("Do not modify files in `010 RAW/`. Do not modify
 * files in `020 HUMAN/` unless explicitly instructed."). Zones cover
 * the positive case (where to write); this overlay closes the negative
 * case the LLM might otherwise interpret as silently allowed.
 */
function getKnowledgeBasePermissions(): AgentOverlay {
	const reason =
		"This folder is read-only per the LifeOS policy. Writes go to 040 FORGE/.";
	return {
		[writeTool.name]: [
			{ kind: "blockInsideDirs", dirs: [KB_RAW_DIR, KB_HUMAN_DIR], reason },
		],
		[editTool.name]: [
			{ kind: "blockInsideDirs", dirs: [KB_RAW_DIR, KB_HUMAN_DIR], reason },
		],
	};
}

/**
 * Knowledge-base agent — manages a personal knowledge base. PR 1
 * scaffold: zones, permission overlay, and a placeholder persona. PR 2
 * will replace `buildInstructions` with the full
 * persona + workflow body. PR 3 will add `commands`.
 */
export const knowledgeBaseAgent: AgentInfo = {
	name: "knowledge-base",
	displayName: "Knowledge Base",
	description: "Manage a personal knowledge base",
	colorKey: "info",
	extraTools: [editTool, writeTool],
	zones: knowledgeBaseZones,
	buildInstructions: () =>
		"You manage a personal knowledge base. Be calm, concise, low-friction.",
	getPermissions: getKnowledgeBasePermissions,
};
