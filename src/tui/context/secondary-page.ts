/**
 * Secondary page — local UI state for displaying a full-screen file
 * viewer that replaces the conversation area.
 *
 * Generic: any agent can open a secondary page to display a file.
 * Not agent/session state — purely a TUI navigation concern.
 *
 * Module-level signal so deeply nested components (UserPart, Sidebar,
 * ArticlePage) can read/write without prop drilling.
 */

import { createSignal } from "solid-js";

const [secondaryPage, setSecondaryPage] = createSignal<{
	filename: string;
} | null>(null);

/** Open a secondary page to display a file. `filename` is vault-relative. */
export function openSecondaryPage(filename: string) {
	setSecondaryPage({ filename });
}

/** Return from the secondary page to the conversation. */
export function closeSecondaryPage() {
	setSecondaryPage(null);
}

/** Current secondary page state (null = conversation visible). */
export function getSecondaryPage() {
	return secondaryPage();
}
