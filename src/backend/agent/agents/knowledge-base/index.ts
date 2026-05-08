import type { AgentOverlay } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import type { AgentCommand, AgentInfo, AgentZone } from "../../types";
import { buildKnowledgeBaseInstructions } from "./instructions";
import { KB_FORGE, KB_HUMAN_DIR, KB_RAW_DIR, KB_SYSTEM } from "./paths";

/**
 * Workspace zones — the LifeOS policy maps `040 FORGE/` to the agent's
 * default write surface and `090 SYSTEM/099 LLM Wiki/` to a confirm-
 * before-write zone (lint's tag-unification step touches
 * `tags-guidance.md` there). Read is vault-wide via `BASE_TOOLS`'
 * `readTool`; zones only constrain writes.
 */
const knowledgeBaseZones: AgentZone[] = [
	{ path: KB_FORGE, write: "auto" },
	{ path: KB_SYSTEM, write: "confirm" },
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
 * Slash commands. The workflow bodies are already in the system prompt
 * (see `instructions.ts`), so each command's job is just to name which
 * workflow the LLM should run. `/query` interpolates the user's
 * question; the others are bare triggers.
 */
const ingestCommand: AgentCommand = {
	name: "ingest",
	description: "Process new 010 RAW/ sources into 040 FORGE/",
	takesArgs: false,
	execute: (_args, helpers) => helpers.prompt("Run the ingest workflow."),
};

const queryCommand: AgentCommand = {
	name: "query",
	description: "Answer a question using the knowledge base",
	argHint: "<question>",
	argGuide: "type your question after /query",
	takesArgs: true,
	execute: (args, helpers) =>
		helpers.prompt(`Run the query workflow.\n\nQuestion: ${args}`),
};

const lintCommand: AgentCommand = {
	name: "lint",
	description: "Audit the vault and unify tags",
	takesArgs: false,
	execute: (_args, helpers) => helpers.prompt("Run the lint workflow."),
};

/**
 * Knowledge-base agent — manages a personal knowledge base. The
 * persona, freeform-routing guidance, and all three workflow bodies
 * (ingest/query/lint) are preloaded into the system prompt; the slash
 * commands here just trigger the matching workflow already in context.
 */
export const knowledgeBaseAgent: AgentInfo = {
	name: "knowledge-base",
	displayName: "Knowledge Base",
	description: "Manage a personal knowledge base",
	colorKey: "info",
	extraTools: [editTool, writeTool],
	zones: knowledgeBaseZones,
	buildInstructions: () => buildKnowledgeBaseInstructions(),
	commands: [ingestCommand, queryCommand, lintCommand],
	getPermissions: getKnowledgeBasePermissions,
};
