import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { DisplayPart } from "@bridge/view-model";
import { ARTICLES_DIR, VAULT_DIR } from "../../constants";
import { type AgentOverlay, isInsideDir } from "../../permissions";
import { editTool, writeTool } from "../../tools";
import { makeListKeysTool, makeSearchTool } from "../../tools/search";
import type { AgentCommand, AgentInfo, AgentZone } from "../../types";
import {
	buildArticleWorkflowPrelude,
	buildReaderInstructions,
} from "./instructions";
import { recommendArticles } from "./recommendations";

/**
 * Core article-loading logic shared by the bare-case (picker) and the
 * arg-case (direct filename). Resolves the filename inside
 * `ARTICLES_DIR`, validates, reads, and sends the opening user message.
 *
 * Splits the display and LLM payloads: `prompt` receives the full
 * `[workflow prelude] + Path: + Content:` blob as `text` (what
 * pi-agent-core hands to pi-ai) and a compact `[short prose, file
 * chip]` array as `displayParts` (what the user bubble renders). See
 * `wrappedActions.prompt` in `src/tui/context/agent.tsx` for the
 * split — pi-agent-core only ever sees `text`, so the LLM gets the
 * full workflow + article while the bubble stays scannable.
 *
 * The workflow prelude (stages, file rules, preservation logic,
 * storage destinations) is prepended here rather than baked into
 * reader's agent system prompt so plain-chat sessions don't pay for
 * it. See `buildArticleWorkflowPrelude` in `./instructions.ts` for
 * the rationale.
 */
async function runArticle(
	filename: string,
	prompt: (text: string, displayParts?: DisplayPart[]) => Promise<void>,
): Promise<void> {
	const articlePath = resolve(ARTICLES_DIR, filename);
	// `isInsideDir` is `path.sep`-boundary-safe and cross-platform;
	// the equality short-circuit also means `articlePath === ARTICLES_DIR`
	// slips through, so we reject the bare-dir case explicitly.
	if (!isInsideDir(articlePath, ARTICLES_DIR) || articlePath === ARTICLES_DIR) {
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
	// Chip filename is vault-relative — shorter than the absolute path
	// and unambiguous inside the vault. The absolute path still goes
	// into the LLM text so tools resolve the same file later.
	const relPath = relative(VAULT_DIR, articlePath);
	const prelude = buildArticleWorkflowPrelude();
	await prompt(
		`${prelude}\nRead this article and begin the reading workflow.\n\nPath: ${articlePath}\n\nContent:\n\n${content}`,
		[
			{ type: "text", text: "Read this article." },
			{ type: "file", mime: "text/markdown", filename: relPath },
		],
	);
}

/**
 * `/article [filename]` — reader's canonical verb.
 *
 * Two modes:
 *
 * 1. **Bare** (`/article` with no argument or whitespace-only):
 *    Scans `ARTICLES_DIR`, scores unread articles using the `index.base`
 *    ranking logic, pushes a numbered recommendation list into the
 *    conversation as a user bubble, then opens a `DialogSelect` picker.
 *    Selecting an article runs the normal loading path. Cancelling (ESC)
 *    leaves the list in the conversation without starting a turn.
 *
 * 2. **With filename** (`/article foo.md`):
 *    Resolves the filename inside `ARTICLES_DIR` only. Rejects paths
 *    that escape the Articles folder, point at the folder itself, don't
 *    exist, resolve through a symlink, or don't resolve to a regular
 *    file. On success, reads the file and hands the path + content to
 *    the LLM as the opening user message, kicking off the 6-stage
 *    reading workflow.
 *
 * `takesArgs: false` so the bare invocation is dispatched by the slash
 * gate (previously `true` caused bare `/article` to fall through as a
 * plain prompt). The command also appears in the Ctrl+P palette —
 * clicking it opens the picker.
 */
const articleCommand: AgentCommand = {
	name: "article",
	description: "Open an article for guided reading",
	argHint: "[filename]",
	argGuide: "use @ to pick a file, or leave empty for recommendations",
	takesArgs: false,
	execute: async (args, helpers) => {
		const filename = args.trim();
		if (!filename) {
			// Bare invocation — show a picker dialog with recommended articles.
			const recs = recommendArticles(10);
			if (recs.length === 0) {
				throw new Error("No unread articles found in the Articles folder");
			}
			if (!helpers.pickFromList) {
				throw new Error("Article picker requires an interactive frontend");
			}
			const picked = await helpers.pickFromList({
				title: "Recommended articles",
				size: "large",
				options: recs.map((r) => ({
					title: r.title,
					value: r.filename,
					description: r.bucket,
				})),
			});
			if (!picked) return; // User cancelled — no turn started.
			return runArticle(picked, helpers.prompt);
		}
		return runArticle(filename, helpers.prompt);
	},
};

/**
 * Reader's search surface over ARTICLES_DIR.
 *
 * Two tools, same scanner, load-on-demand (no prompt-time scan):
 *
 * - `search` — filter articles by frontmatter (author / tags / date /
 *   whatever keys the corpus uses) and/or body content. Returns
 *   filenames; attaches frontmatter or content snippets depending on
 *   which filter was supplied.
 * - `list_keys` — enumerate observed frontmatter keys with one sample
 *   each so the LLM knows what fields to filter on before calling
 *   `search`. Call this first for any non-trivial query.
 *
 * Descriptions teach the call sequence explicitly so the LLM doesn't
 * burn a turn on an empty `{ frontmatter: { authors: ... } }` result
 * when the actual key is `author`. Factories live in
 * `backend/agent/tools/search.ts`; the factory approach keeps these
 * vault-agnostic so a future notes-agent / book-agent can use the
 * same primitive scoped to its own directory.
 */
const readerSearchTool = makeSearchTool({
	dir: ARTICLES_DIR,
	name: "search",
	description:
		"Search the user's article library by frontmatter fields and/or body content. " +
		"Use `filter.frontmatter` (a { key: value } map) for structured queries like " +
		"author, tags, or dates — values are substrings, case-insensitive, and array " +
		"values match if any element contains the substring. Use `filter.content` for " +
		"a keyword search over article bodies; matching articles come back with up to " +
		"3 snippets of surrounding context. Combine both filters when you know the " +
		"topic and something structural (e.g. author). If you're not sure which keys " +
		"exist, call `list_keys` first — guessing `authors` when the corpus uses " +
		"`author` returns empty results.",
});

const readerListKeysTool = makeListKeysTool({
	dir: ARTICLES_DIR,
	name: "list_keys",
	description:
		"List the frontmatter keys present across the user's article library, with one " +
		"sample value per key. Call this before constructing a `search` filter when you " +
		"don't already know the corpus's frontmatter shape — it's one cheap round-trip " +
		"that keeps the subsequent `search` call from missing articles because of a " +
		"key name mismatch (e.g. `author` vs `authors`, `tags` vs `keywords`).",
});

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
 * Reader — the reading guide. Walks the user through the 6-stage
 * reading workflow (see `./instructions.ts`) and manages article
 * frontmatter edits, scraps, and notes inside the vault.
 *
 * Tools: `read` comes from `BASE_TOOLS`; `edit` + `write` are pulled
 * from the shared pool in `backend/agent/tools.ts`; `search` +
 * `list_keys` are factory-produced from `backend/agent/tools/search.ts`
 * scoped to `ARTICLES_DIR` so the LLM can locate articles for freeform
 * "find me the one about X" prompts.
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description: "Obsidian reading guide",
	colorKey: "secondary",
	extraTools: [editTool, writeTool, readerSearchTool, readerListKeysTool],
	zones: readerZones,
	buildInstructions: () => buildReaderInstructions(),
	commands: [articleCommand],
	getPermissions: getReaderPermissions,
};
