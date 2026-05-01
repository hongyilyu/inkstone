/**
 * Secondary page — local UI state for displaying a full-screen page
 * that replaces the conversation area.
 *
 * Generic: any agent or component can open a secondary page with
 * arbitrary markdown content. Use cases: file viewer, subagent
 * output, help pages, etc.
 *
 * Not agent/session state — purely a TUI navigation concern.
 *
 * Module-level signal so deeply nested components (UserPart, Sidebar,
 * SecondaryPage) can read/write without prop drilling.
 */

import { createSignal } from "solid-js";

export interface SecondaryPageState {
	/** Markdown content to render. */
	// TODO: Currently only supports markdown rendering. Expand to support
	// other formats (plain text, structured data, custom JSX) when needed
	// — e.g. subagent work output, logs, or non-markdown file types.
	content: string;
	/** Optional title shown in the sidebar. */
	title?: string;
}

const [secondaryPage, setSecondaryPage] =
	createSignal<SecondaryPageState | null>(null);

/** Open a secondary page with the given markdown content. */
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
