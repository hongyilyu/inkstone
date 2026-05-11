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
import { useRenderer } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { getSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";
import type { ThemeColors } from "../theme/types";
import { splitWikilinks } from "../util/wikilink";
import { KittyImageRenderable } from "./kitty-image";

/**
 * Mount a `KittyImageRenderable` as a child of a Solid `<box>` host.
 *
 * OpenTUI's Solid bindings only know how to spawn renderables registered
 * in the component catalogue (`box`, `text`, `markdown`, …). Our image
 * renderable lives outside that catalogue, so we attach it manually as
 * a child of the host `<box>` after mount.
 *
 * Solid reuses `ImageBlock` instances across `.map` re-renders when the
 * unkeyed segment array reshuffles, so we tear the old image renderable
 * down and rebuild it via `createEffect` keyed on `props.href`. Without
 * that, an `href` change would leave the previous renderable attached
 * to the host with no path to ever destroy it (Ghostty-side image bytes
 * survive the process anyway, but the orphaned render command would
 * keep painting placeholder cells over the new image).
 */
interface ImageBlockProps {
	href: string;
	renderer: ReturnType<typeof useRenderer>;
}

function ImageBlock(props: ImageBlockProps) {
	// The host `<box>` defaults to `auto` height, which Yoga collapses
	// to 0 unless we explicitly tell it. The image renderable knows its
	// own row count once `onResize` runs, but the host box doesn't
	// observe that — so we mirror the renderable's `height` into a
	// Solid signal that drives the host box's `height` prop.
	const [rows, setRows] = createSignal(1);
	let host: unknown = null;
	let imageNode: KittyImageRenderable | null = null;

	const captureHost = (h: unknown) => {
		host = h;
	};

	createEffect(
		on(
			() => props.href,
			(href) => {
				if (imageNode) {
					imageNode.destroy();
					imageNode = null;
				}
				if (!host) return;
				setRows(1);
				const node = new KittyImageRenderable(props.renderer, {
					href,
					onLayout: (n) => setRows(n),
				});
				imageNode = node;
				(host as { add: (child: unknown) => void }).add(node);
			},
		),
	);

	onCleanup(() => {
		imageNode?.destroy();
		imageNode = null;
	});

	// `marginTop`/`marginBottom` give visual breathing room around the
	// image; the host's `height` is driven by the image's row count
	// (1 for fallback text; intrinsic-aspect rows for an image upload).
	return (
		<box
			ref={captureHost}
			flexDirection="column"
			height={rows()}
			flexShrink={0}
			marginTop={1}
			marginBottom={1}
		/>
	);
}

export function SecondaryPage() {
	const { theme, syntax } = useTheme();
	const renderer = useRenderer();

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

	// For markdown format, split the body into a stream of text + image
	// segments. Each text segment renders through `<markdown>`; each
	// image segment mounts a `KittyImageRenderable` via `ImageBlock`. We
	// don't try to use OpenTUI's `MarkdownRenderable.renderNode` hook
	// because its lifecycle destroys custom children on the second
	// `updateBlocks` pass (rationale in `util/wikilink.ts`).
	const segments = createMemo(() => {
		if (format() !== "markdown") return [];
		return splitWikilinks(body());
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
						{segments().map((seg) =>
							seg.kind === "text" ? (
								<markdown
									content={seg.content}
									syntaxStyle={syntax()}
									fg={theme.text}
									bg={theme.background}
									flexShrink={0}
									tableOptions={{
										style: "grid",
										wrapMode: "word",
										borders: true,
										cellPadding: 1,
									}}
								/>
							) : (
								<ImageBlock href={seg.href} renderer={renderer} />
							),
						)}
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
