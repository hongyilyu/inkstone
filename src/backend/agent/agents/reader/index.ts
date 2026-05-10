import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

type ArticleResolveError =
	| "not-inside-articles"
	| "missing"
	| "symlink"
	| "not-regular-file";

type ArticleResolveResult =
	| { ok: true; path: string }
	| { ok: false; reason: ArticleResolveError };

/**
 * Resolve a `/article` argument to an absolute path that points at a
 * regular file inside `ARTICLES_DIR`, or a discriminated error reason.
 *
 * Shared by `runArticle` (translates the reason to a specific thrown
 * error message) and `articleCommand.canExecute` (consumes the boolean
 * `ok` flag). Keeping a single resolver guarantees the gate's "would
 * dispatch succeed?" check and `runArticle`'s success criteria can't
 * drift.
 */
function resolveArticlePath(filename: string): ArticleResolveResult {
	const articlePath = isAbsolute(filename)
		? filename
		: resolve(ARTICLES_DIR, filename);
	if (!isInsideDir(articlePath, ARTICLES_DIR) || articlePath === ARTICLES_DIR) {
		return { ok: false, reason: "not-inside-articles" };
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(articlePath);
	} catch {
		return { ok: false, reason: "missing" };
	}
	if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
	if (!stat.isFile()) return { ok: false, reason: "not-regular-file" };
	return { ok: true, path: articlePath };
}

/**
 * Shared loader for `/article`'s two invocation modes (picker / direct
 * filename).
 *
 * Accepts either a bare filename (`foo.md`) or an absolute path inside
 * `ARTICLES_DIR` (what `@`-autocomplete's mention expansion produces).
 * Both must resolve inside `ARTICLES_DIR`.
 *
 * LLM-facing `text` carries `[workflow prelude] + Path: + Content:`;
 * bubble `displayParts` is just a short prose line + file chip. See
 * `wrappedActions.prompt` in `src/tui/context/agent.tsx` for the
 * split and `docs/AGENT-DESIGN.md` D14 for the workflow-in-message
 * rationale.
 */
async function runArticle(
	filename: string,
	prompt: (text: string, displayParts?: DisplayPart[]) => Promise<void>,
): Promise<void> {
	const result = resolveArticlePath(filename);
	if (!result.ok) {
		switch (result.reason) {
			case "not-inside-articles":
				throw new Error(`Not a file inside the Articles folder: '${filename}'`);
			case "missing":
				throw new Error(`Article not found: ${filename}`);
			case "symlink":
				throw new Error(
					`Symlinks are not supported for /article: '${filename}'`,
				);
			case "not-regular-file":
				throw new Error(`Not a regular file: ${filename}`);
		}
	}
	const articlePath = result.path;
	const content = readFileSync(articlePath, "utf-8");
	// Chip shows vault-relative path (shorter, unambiguous); LLM text
	// carries the absolute form so tools resolve the same file later.
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
 * `/article [filename]` — reader's canonical verb. Bare → picker from
 * recommended unread articles; with filename → load directly.
 *
 * `takesArgs: false` so the bare form is slash-dispatched (not falling
 * through as a plain prompt).
 *
 * `canExecute` (rule 3 in `canRunSlashEntry`) gates the optional-arg
 * shape: bare invocation always dispatches (picker path); a non-bare
 * arg dispatches only if it resolves to a regular file inside the
 * Articles dir. Otherwise the prompt falls through to a plain prompt
 * with the literal `/article …` text intact — so accidental
 * `/article is a misleading title…` reaches the model as prose
 * instead of toasting "Article not found." Side effect: a typo'd
 * filename also falls through to plain prompt rather than toasting;
 * matches the Discord/Slack convention.
 */
const articleCommand: AgentCommand = {
	name: "article",
	description: "Open an article for guided reading",
	argHint: "[filename]",
	argGuide: "use @ to pick a file, or leave empty for recommendations",
	takesArgs: false,
	canExecute: (args) => {
		const filename = args.trim();
		if (!filename) return true;
		return resolveArticlePath(filename).ok;
	},
	execute: async (args, helpers) => {
		const filename = args.trim();
		if (!filename) {
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
			if (!picked) return;
			return runArticle(picked, helpers.prompt);
		}
		return runArticle(filename, helpers.prompt);
	},
};

/**
 * Reader's search surface over ARTICLES_DIR. `search` + `list_keys`
 * are generic factories (see `backend/agent/tools/search.ts`) kept
 * vault-agnostic so a future notes/book agent can reuse the primitive
 * scoped to its own directory.
 *
 * Tool descriptions teach the call sequence (`list_keys` first when
 * the LLM doesn't know the corpus's frontmatter shape).
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

/** Reader's workspace — three zones, all confirm-before-write. */
const readerZones: AgentZone[] = [
	{ path: "010 RAW/013 Articles", write: "confirm" },
	{ path: "020 HUMAN/022 Scraps", write: "confirm" },
	{ path: "020 HUMAN/023 Notes", write: "confirm" },
];

/**
 * Static Articles-zone rules: `write` blocked outright (articles are
 * read-only source material; `edit` handles frontmatter updates),
 * `edit` restricted to frontmatter hunks. Zone-wide (not per-file) so
 * the reader stays stateless — see `docs/AGENT-DESIGN.md` →
 * "Reader-specific vocabulary leaks" for the history.
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
 * Reader — the reading guide. Persona in `./instructions.ts`; the
 * 6-stage workflow lives in `buildArticleWorkflowPrelude` and is
 * prepended to `/article`'s opening user message (D14).
 */
export const readerAgent: AgentInfo = {
	name: "reader",
	displayName: "Reader",
	description:
		"A reading-focused agent for the user's article corpus. Use for any " +
		"request about reading, exploring, or asking questions about saved " +
		'articles — including freeform browsing ("what did I save yesterday") ' +
		'and direct file references ("read foo.md"). Has plain-chat capability.',
	colorKey: "secondary",
	extraTools: [editTool, writeTool, readerSearchTool, readerListKeysTool],
	zones: readerZones,
	buildInstructions: () => buildReaderInstructions(),
	commands: [articleCommand],
	getPermissions: getReaderPermissions,
};
