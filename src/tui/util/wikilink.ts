/**
 * Split an Obsidian-flavored markdown body into a stream of segments
 * where each Obsidian wikilink image (`![[<vault path>]]`) becomes its
 * own segment that the secondary page mounts as a Kitty image
 * renderable. The remaining text segments are passed through to
 * OpenTUI's `<markdown>` unchanged.
 *
 * We split rather than rewrite because OpenTUI 0.1.99's
 * `MarkdownRenderable._renderNode` predicate is consulted only on the
 * first `updateBlocks` pass; subsequent re-parses (triggered every time
 * `content` is reassigned, including same-value reassignments under
 * Solid's reactive prop pipeline) hit `updateBlockRenderable`, which
 * destroys the custom child and replaces it with a default markdown
 * code renderable. Block splitting sidesteps the lifecycle entirely:
 * each image lives outside `<markdown>` as its own sibling under a
 * column box.
 *
 * The matcher accepts an optional `|<size>` segment (Obsidian resize
 * hint) and discards it — corpus has zero today, so wiring the size
 * through to the renderable is YAGNI. The matcher fires on lines whose
 * sole non-whitespace content is the wikilink; embedded wikilinks
 * inside a paragraph stay in the text segment and render as literal
 * `![[...]]` (corpus has no such cases).
 */

const RE_LINE = /^[ \t]*!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\][ \t]*$/;

export type WikilinkSegment =
	| { kind: "text"; content: string }
	| { kind: "image"; href: string };

export function splitWikilinks(md: string): WikilinkSegment[] {
	const lines = md.split("\n");
	const segments: WikilinkSegment[] = [];
	let buffer: string[] = [];

	const flushBuffer = () => {
		if (buffer.length === 0) return;
		// Trim leading and trailing blank lines from each text segment so
		// the visual gap between an image and the next paragraph is the
		// image's own marginBottom plus one blank line, not two or three.
		while (buffer.length > 0 && buffer[0].trim() === "") buffer.shift();
		while (buffer.length > 0 && buffer[buffer.length - 1].trim() === "") {
			buffer.pop();
		}
		if (buffer.length > 0) {
			segments.push({ kind: "text", content: buffer.join("\n") });
		}
		buffer = [];
	};

	for (const line of lines) {
		const m = line.match(RE_LINE);
		if (m) {
			flushBuffer();
			segments.push({ kind: "image", href: m[1].trim() });
		} else {
			buffer.push(line);
		}
	}
	flushBuffer();

	return segments;
}
