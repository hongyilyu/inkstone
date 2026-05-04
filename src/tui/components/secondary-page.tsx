/**
 * Full-screen secondary page. Replaces the conversation area when
 * a secondary page is open. Renders content in a scrollable main area.
 *
 * Generic: content + format are provided by the caller via
 * `openSecondaryPage()`. Markdown is the default (reader's `/article`
 * and `@`-mention previews); `"text"` renders raw text for non-markdown
 * content like subagent output or logs.
 *
 * Markdown-format callers get two reader-focused affordances on top
 * of OpenTUI's `<markdown>`:
 *   1. YAML frontmatter at the top of the content is parsed out and
 *      rendered as a compact metadata strip above the body (title,
 *      author, published date, url). Matches the captured-article
 *      shape from the Obsidian Clipper exports (title / author /
 *      published / url fields are universal across the corpus).
 *   2. GFM tables use the `"grid"` style with bordered cells and word
 *      wrap — the reader has the full width to afford the extra
 *      visual weight, while inline assistant/sidebar markdown keeps
 *      OpenTUI's default compact borderless `"columns"` layout.
 *
 * `"text"` format bypasses both affordances; the raw text renders
 * verbatim so logs / subagent output aren't mangled by the markdown
 * parser or the frontmatter heuristic.
 *
 * Navigation: ESC/Ctrl+[ or the sidebar back button calls
 * `closeSecondaryPage()`.
 */

import { fmString, fmStringArray, parseFrontmatter } from "@bridge/frontmatter";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { getSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";
import type { ThemeColors } from "../theme/types";

export function SecondaryPage() {
	const { theme, syntax } = useTheme();

	const state = () => getSecondaryPage();
	const rawContent = () => state()?.content ?? "";
	const format = () => state()?.format ?? "markdown";

	// Parse frontmatter only when format is markdown. For `"text"` we
	// don't want to silently strip `---\n...\n---` from the top of a
	// log or subagent dump — that would be a surprise, not an
	// affordance. The memo re-runs whenever the content signal
	// changes; cheap given the parser is linear in the frontmatter
	// block length.
	const parsed = createMemo(() => {
		if (format() !== "markdown") return null;
		return parseFrontmatter(rawContent());
	});

	// Memoized body trims one leading blank line between the metadata
	// strip and the first heading so the vertical rhythm stays tight
	// without eating author-intentional paragraph breaks further down.
	// Coupled with `ArticleHeader`'s `marginBottom={1}` — removing
	// either in isolation collapses the gap differently, so they ship
	// as a pair.
	const body = createMemo(() => {
		const p = parsed();
		if (!p) return rawContent();
		return p.body.startsWith("\n") ? p.body.slice(1) : p.body;
	});

	// Memoized so `<Show when={frontmatter()}>` sees a stable reference
	// across renders that don't change the parsed fields — otherwise
	// every `rawContent` change would allocate a fresh object and
	// re-mount ArticleHeader even when its visible fields hadn't moved.
	const frontmatter = createMemo(() => {
		const p = parsed();
		if (!p) return null;
		const title = fmString(p.fields.title);
		const authors = fmStringArray(p.fields.author);
		const published = fmString(p.fields.published);
		const url = fmString(p.fields.url);
		// Render the strip only when the frontmatter carries at least
		// one surfaced field. An article with unsupported-shape
		// frontmatter (e.g. only `reading_intent`) strips the raw YAML
		// but doesn't fabricate an empty header above the body.
		if (!title && authors.length === 0 && !published && !url) return null;
		return { title, authors, published, url };
	});

	return (
		<scrollbox
			flexGrow={1}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<Show
				when={format() === "text"}
				fallback={
					<box flexDirection="column">
						<Show when={frontmatter()}>
							{(fm) => <ArticleHeader frontmatter={fm()} colors={theme} />}
						</Show>
						<markdown
							content={body()}
							syntaxStyle={syntax()}
							fg={theme.text}
							bg={theme.background}
							tableOptions={{
								style: "grid",
								wrapMode: "word",
								borders: true,
								cellPadding: 1,
							}}
						/>
					</box>
				}
			>
				<text fg={theme.text} bg={theme.background} wrapMode="word">
					{rawContent()}
				</text>
			</Show>
		</scrollbox>
	);
}

// ---------------------------------------------------------------------------
// Metadata strip rendered above the article body for markdown-format
// callers whose content starts with a `---` frontmatter block.
//
// Three lines max, each optional:
//   1. Title (bold, `primary` — matches the H1 style from syntax.ts so a
//      frontmatter title reads with the same visual weight as an inline
//      `# Title` heading in articles that have both).
//   2. `by <author(s)> · <published>` in `textMuted`. Individual
//      segments drop when missing; the `·` separator only appears
//      between two present segments.
//   3. URL, in `info` (same color as markdown `markup.link` but rendered
//      as plain text so the terminal shows the literal URL the user
//      can copy instead of OpenTUI's link concealment).
//
// All lines are plain `<text>` nodes — running this through the
// markdown renderer would require escaping author names / URLs that
// happen to contain `*`, `_`, or `[`, which none of the captured
// articles currently need.
// ---------------------------------------------------------------------------

interface ArticleHeaderProps {
	frontmatter: {
		title?: string;
		authors: string[];
		published?: string;
		url?: string;
	};
	colors: ThemeColors;
}

function ArticleHeader(props: ArticleHeaderProps) {
	const subline = () => {
		const { authors, published } = props.frontmatter;
		const left = authors.length > 0 ? `by ${authors.join(", ")}` : "";
		const right = published ?? "";
		if (left && right) return `${left} · ${right}`;
		return left || right;
	};

	return (
		<box flexDirection="column" marginBottom={1}>
			<Show when={props.frontmatter.title}>
				{(title) => (
					<text
						fg={props.colors.primary}
						bg={props.colors.background}
						attributes={TextAttributes.BOLD}
					>
						{title()}
					</text>
				)}
			</Show>
			<Show when={subline().length > 0}>
				<text fg={props.colors.textMuted} bg={props.colors.background}>
					{subline()}
				</text>
			</Show>
			<Show when={props.frontmatter.url}>
				{(url) => (
					<text fg={props.colors.info} bg={props.colors.background}>
						{url()}
					</text>
				)}
			</Show>
		</box>
	);
}
