import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARTICLES_DIR } from "../../constants";
import { type AgentOverlay, isInsideDir } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import type { AgentCommand, AgentInfo, AgentZone } from "../../types";
import { buildReaderInstructions } from "./instructions";

/**
 * `/article <filename>` — reader's canonical verb.
 *
 * Resolves the filename inside `ARTICLES_DIR` only. Rejects paths that
 * escape the Articles folder, point at the folder itself, don't exist,
 * resolve through a symlink, or don't resolve to a regular file. On
 * success, reads the file and hands the path + content to the LLM as
 * the opening user message, kicking off the 6-stage reading workflow.
 *
 * Symlinks are rejected as a class (`lstatSync` + reject if
 * `isSymbolicLink()`). A symlink inside Articles pointing at an
 * arbitrary file outside the vault would otherwise pass the
 * `isInsideDir` check (which operates on the lexical path) and leak
 * external content through the opening user message. The vault is
 * trusted content, so this is defense-in-depth, not a hard boundary —
 * but the error text claims "inside the Articles folder" and we keep
 * that claim true.
 *
 * Whitespace-only args throw rather than silently returning; a typed
 * `/article   ` would otherwise produce no visible outcome.
 *
 * No cross-turn state: the article lives in the conversation history,
 * and reader's permission rules apply statically to any file inside
 * the Articles zone.
 */
const articleCommand: AgentCommand = {
	name: "article",
	description: "Open an article for guided reading",
	argHint: "<filename>",
	takesArgs: true,
	execute: async (args, prompt) => {
		const filename = args.trim();
		if (!filename) {
			throw new Error("Missing filename. Usage: /article <filename>");
		}
		const articlePath = resolve(ARTICLES_DIR, filename);
		// `isInsideDir` is `path.sep`-boundary-safe and cross-platform;
		// the equality short-circuit also means `articlePath === ARTICLES_DIR`
		// slips through, so we reject the bare-dir case explicitly.
		if (
			!isInsideDir(articlePath, ARTICLES_DIR) ||
			articlePath === ARTICLES_DIR
		) {
			throw new Error(`Not a file inside the Articles folder: '${filename}'`);
		}
		// `lstatSync` doesn't follow symlinks; combined with the
		// `isSymbolicLink()` reject, this closes the symlink-out-of-vault
		// hole (a link inside Articles that points at an arbitrary file).
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(articlePath);
		} catch {
			throw new Error(`Article not found: ${filename}`);
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`Symlinks are not supported for /article: '${filename}'`);
		}
		if (!stat.isFile()) {
			throw new Error(`Not a regular file: ${filename}`);
		}
		const content = readFileSync(articlePath, "utf-8");
		await prompt(
			`Read this article and begin the reading workflow.\n\nPath: ${articlePath}\n\nContent:\n\n${content}`,
		);
	},
};

/**
 * Reader's workspace — three zones, all confirm-before-write.
 */
const readerZones: AgentZone[] = [
	{ path: "010 RAW/013 Articles", write: "confirm" },
	{ path: "020 HUMAN/022 Scraps", write: "confirm" },
	{ path: "020 HUMAN/023 Notes", write: "confirm" },
];

/**
 * Reader's permission overlay — static rules on the Articles zone.
 *
 * - `write` anywhere inside Articles is blocked (articles are treated
 *   as read-only source material; use `edit` for frontmatter updates).
 * - `edit` inside Articles is restricted to frontmatter hunks via
 *   `frontmatterOnlyInDirs`.
 *
 * Non-article paths aren't matched by either rule (`blockInsideDirs`
 * and `frontmatterOnlyInDirs` both gate on prefix).
 *
 * Previously this overlay keyed on the currently-active article path,
 * which required module-level `activeArticle` state plumbed through
 * command context, store, persistence, and sidebar. Moving to
 * zone-wide static rules applies the protection to every article — a
 * deliberate behavior broadening (tracked in TODO) that trades
 * per-file precision for a stateless reader.
 */
function getReaderPermissions(): AgentOverlay {
	return {
		[writeTool.name]: [
			{
				kind: "blockInsideDirs",
				dirs: [ARTICLES_DIR],
				reason:
					"Articles are read-only source material. Use edit to modify frontmatter only.",
			},
		],
		[editTool.name]: [{ kind: "frontmatterOnlyInDirs", dirs: [ARTICLES_DIR] }],
	};
}

/**
 * Reader — the Obsidian reading guide. Walks the user through the
 * 6-stage reading workflow (see `./instructions.ts`) and manages
 * article frontmatter edits, scraps, and notes inside the vault.
 *
 * Tools: `read` comes from `BASE_TOOLS`; `edit` + `write` are pulled
 * from the shared pool in `backend/agent/tools.ts`.
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description: "Obsidian reading guide",
	colorKey: "secondary",
	extraTools: [editTool, writeTool],
	zones: readerZones,
	buildInstructions: () => buildReaderInstructions(),
	commands: [articleCommand],
	getPermissions: getReaderPermissions,
};
