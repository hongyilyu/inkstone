import { join } from "node:path";
import { VAULT_DIR } from "../../constants";
import type { AgentOverlay } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import type { AgentCommand, AgentInfo } from "../../types";
import { todayLocalDate } from "../../util/local-date";
import { buildKnowledgeBaseInstructions } from "./instructions";
import { KB_FORGE, KB_SYSTEM } from "./paths";

// Knowledge-base permission overlay.
//
// `write` and `edit` are allowed in Forge (auto) and the LLM Wiki
// system folder (confirm — lint's tag-unification step writes
// `tags-guidance.md` there). Everything else in the vault, including
// RAW and HUMAN, falls outside `insideDirs` and is rejected by the
// dispatcher. The LifeOS read-only policy on RAW/HUMAN is documented
// in the agent's workflow instructions, not as a per-rule reason.
function getKnowledgeBasePermissions(): AgentOverlay {
	const forgeDir = join(VAULT_DIR, KB_FORGE);
	const systemDir = join(VAULT_DIR, KB_SYSTEM);
	const inside = {
		kind: "insideDirs" as const,
		dirs: [forgeDir, systemDir],
	};
	const confirm = { kind: "confirmDirs" as const, dirs: [systemDir] };
	return {
		[writeTool.name]: [inside, confirm],
		[editTool.name]: [inside, confirm],
	};
}

// Workflow bodies live in the system prompt (`instructions.ts`); each
// command is a minimal trigger that names which workflow to run.
//
// Session title: `/ingest` and `/lint` declare deterministic titles
// (`Ingest · YYYY-MM-DD` / `Lint · YYYY-MM-DD`) so the session list
// shows the workflow + run date directly. These verbs have no per-
// session content to summarize — an LLM paraphrase would just produce
// drift. `/query`'s title still goes through the LLM path because the
// question IS the per-session content (the LLM gets a sub-4KB prompt
// and produces a sensible "Postgres connection question"-style title).
const ingestCommand: AgentCommand = {
	name: "ingest",
	description: "Process new 010 RAW/ sources into 040 FORGE/",
	takesArgs: false,
	execute: (_args, helpers) =>
		helpers.prompt("Run the ingest workflow.", {
			title: `Ingest · ${todayLocalDate()}`,
		}),
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
	execute: (_args, helpers) =>
		helpers.prompt("Run the lint workflow.", {
			title: `Lint · ${todayLocalDate()}`,
		}),
};

export const knowledgeBaseAgent: AgentInfo = {
	name: "knowledge-base",
	displayName: "Knowledge Base",
	description:
		"A workflow-driven agent for knowledge-base maintenance. Use for " +
		"explicit actions on the vault: ingesting new RAW sources, linting/" +
		"unifying tags across the vault, or answering structured questions " +
		"against the KB. No plain-chat mode — every session is one of those " +
		"three workflows.",
	colorKey: "info",
	extraTools: [editTool, writeTool],
	buildInstructions: () => buildKnowledgeBaseInstructions(),
	commands: [ingestCommand, queryCommand, lintCommand],
	getPermissions: getKnowledgeBasePermissions,
};
