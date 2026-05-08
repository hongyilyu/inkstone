import type { AgentOverlay } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import type { AgentCommand, AgentInfo, AgentZone } from "../../types";
import { buildKnowledgeBaseInstructions } from "./instructions";
import { KB_FORGE, KB_HUMAN_DIR, KB_RAW_DIR, KB_SYSTEM } from "./paths";

// Forge is the default write surface; the LLM Wiki system folder is
// confirm-write because lint's tag-unification step writes
// `tags-guidance.md` there.
const knowledgeBaseZones: AgentZone[] = [
	{ path: KB_FORGE, write: "auto" },
	{ path: KB_SYSTEM, write: "confirm" },
];

// LifeOS policy: `010 RAW/` and `020 HUMAN/` are read-only. Zones
// declare positive write locations; this overlay closes the negative
// case so it isn't silently inferred from "not zoned, still in vault".
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

// Workflow bodies live in the system prompt (`instructions.ts`); each
// command is a minimal trigger that names which workflow to run.
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
