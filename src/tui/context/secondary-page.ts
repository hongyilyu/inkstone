/**
 * Secondary page — local UI state for displaying a full-screen page
 * that replaces the conversation area.
 *
 * Generic: any agent or component can open a secondary page. Today's
 * callers pass markdown; `format: "text"` is available for plain-text
 * content (future subagent output, logs, etc.) and renders without the
 * markdown parser.
 *
 * Not agent/session state — this module is purely the page-shape type
 * declaration plus the public `getSecondaryPage`/`openSecondaryPage`/
 * `closeSecondaryPage` surface. All actual storage, per-session
 * scoping, and back/forward history live in `secondary-page-history.ts`,
 * which this module re-exports from. See that file for the full
 * navigation contract and ADR `0017-per-session-back-forward-history`
 * for the rationale.
 *
 * Existing callers that just want "open this page" or "close the
 * page" import unchanged from here; the history split is invisible
 * unless you also need `goBack` / `goForward` / `canGoBack` /
 * `canGoForward`, which live in `secondary-page-history.ts`.
 */

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

export {
	closeSecondaryPage,
	getSecondaryPage,
	openSecondaryPage,
} from "./secondary-page-history";
