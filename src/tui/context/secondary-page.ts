/**
 * Secondary page — local UI state for displaying a full-screen page
 * that replaces the conversation area.
 *
 * Generic: any agent or component can open a secondary page. Today's
 * callers pass markdown; `format: "text"` is available for plain-text
 * content (future subagent output, logs, etc.) and renders without the
 * markdown parser.
 *
 * Not agent/session state — purely a TUI navigation concern.
 *
 * Module-level signal so deeply nested components (UserPart, Sidebar,
 * SecondaryPage) can read/write without prop drilling.
 */

import { createSignal } from "solid-js";

export type SecondaryPageFormat = "markdown" | "text";

export interface SecondaryPageState {
	/** Body content to render. Interpreted according to `format`. */
	content: string;
	/** Optional title shown in the sidebar. */
	title?: string;
	/**
	 * How to render `content`. Defaults to `"markdown"` (today's behavior
	 * for reader's `/article` and `@`-mention previews).
	 *
	 * `"text"` renders as raw text inside the scrollbox with word-wrap —
	 * use this for non-markdown content (subagent work output, logs,
	 * structured data) where the markdown parser would mangle the source.
	 * Horizontal scroll is not supported today.
	 */
	format?: SecondaryPageFormat;
}

const [secondaryPage, setSecondaryPage] =
	createSignal<SecondaryPageState | null>(null);

/** Open a secondary page with the given content. */
export function openSecondaryPage(state: SecondaryPageState) {
	setSecondaryPage(state);
}

/** Return from the secondary page to the conversation. */
export function closeSecondaryPage() {
	setSecondaryPage(null);
}

/** Current secondary page state (null = conversation visible). */
export function getSecondaryPage() {
	return secondaryPage();
}
