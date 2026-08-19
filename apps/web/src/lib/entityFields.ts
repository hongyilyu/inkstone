// The single source of truth for the entity FIELD SURFACE: the status/state
// value domains, the `{value,label}` option arrays the editors render, and the
// pure coercers (parseAliases/asProjectStatus/asMediaMedium/asMediaState). A
// PURE LEAF — it imports nothing (no React, no lucide, no
// libraryItems/entityCodec/components — only the wire JSON types), so every
// consumer (codec, proposalEdit,
// intentGraphReview, the rail editors, the proposal card) reads ONE answer for
// "how is a Project's status spelled, what media states exist".

import type { JsonObject, JsonValue } from "@inkstone/protocol";
import { asString } from "@/lib/readPayload";

/** The Project GTD status domain (ADR-0031). */
export const PROJECT_STATUSES = [
	{ value: "active", label: "Active" },
	{ value: "on_hold", label: "On hold" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
] as const;

/** The Media medium domain, value + display label (ADR-0059). */
export const MEDIA_MEDIUMS = [
	{ value: "link", label: "Link" },
	{ value: "article", label: "Article" },
	{ value: "book", label: "Book" },
	{ value: "tv", label: "TV" },
	{ value: "movie", label: "Movie" },
] as const;

/** The Media lifecycle-state domain — the queue→log states (ADR-0059). */
export const MEDIA_STATES = [
	{ value: "backlog", label: "Backlog" },
	{ value: "consuming", label: "Consuming" },
	{ value: "done", label: "Done" },
	{ value: "abandoned", label: "Abandoned" },
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number]["value"];
export type MediaMedium = (typeof MEDIA_MEDIUMS)[number]["value"];
export type MediaState = (typeof MEDIA_STATES)[number]["value"];

// The option arrays the `<EditorSelect>` call sites map over. Each canonical
// array already IS `[{value,label}]`, so the option arrays simply alias the
// canonical arrays under the names the call sites use.
export const PROJECT_STATUS_OPTIONS = PROJECT_STATUSES;
export const MEDIA_MEDIUM_OPTIONS = MEDIA_MEDIUMS;
export const MEDIA_STATE_OPTIONS = MEDIA_STATES;

/** Parse a comma-separated aliases/field string into a trimmed, non-empty `string[]`. */
export function parseAliases(raw: string): string[] {
	return raw
		.split(",")
		.map((a) => a.trim())
		.filter((a) => a.length > 0);
}

/**
 * The single owner of the GTD status↔terminal-timestamp coupling on a WRITE target
 * (ADR-0031/0033), shared by the Project update builder (entityCodec) and the
 * create-overlays (proposalEdit). Mutates `target` IN PLACE: `→completed` stamps
 * `completed_at` = `nowString` and clears `dropped_at`; `→dropped` mirrors;
 * `→active`/`→on_hold` clears both.
 *
 * `nowString` is injected (not read here) so this stays a pure leaf with no clock
 * dependency; callers pass `localNowString()`.
 */
export function stampStatusTimestamps(
	target: JsonObject,
	status: string,
	nowString: string,
): void {
	const clear = (key: "completed_at" | "dropped_at") => {
		delete target[key];
	};
	if (status === "completed") {
		target.completed_at = nowString;
		clear("dropped_at");
	} else if (status === "dropped") {
		target.dropped_at = nowString;
		clear("completed_at");
	} else {
		clear("completed_at");
		clear("dropped_at");
	}
}

/** Coerce a stored value to a Project status, degrading anything unrecognized to "active". */
export function asProjectStatus(value: JsonValue | undefined): ProjectStatus {
	const status = asString(value);
	return PROJECT_STATUSES.find((s) => s.value === status)?.value ?? "active";
}

/** Coerce a stored value to a Media medium, degrading anything unrecognized to "link"
 * (the migration's bookmark→media default — a sparse/legacy row never crashes). */
export function asMediaMedium(value: JsonValue | undefined): MediaMedium {
	const medium = asString(value);
	return MEDIA_MEDIUMS.find((m) => m.value === medium)?.value ?? "link";
}

/** Coerce a stored value to a Media state, degrading anything unrecognized to "done"
 * (the migration's bookmark→media default — a sparse/legacy row never crashes). */
export function asMediaState(value: JsonValue | undefined): MediaState {
	const state = asString(value);
	return MEDIA_STATES.find((s) => s.value === state)?.value ?? "done";
}

/**
 * The terminal states in which a finish `rating`/`finished_at` is meaningful
 * (ADR-0059). The single source for this rule on the web side — the editor gates
 * its rating/finished inputs on it and the codec drops finish data off-terminal,
 * mirroring Core's `media_state_finish_invariant`. Keep co-located with the
 * `MediaState` domain so the two can't drift.
 */
export function isMediaTerminalState(state: MediaState): boolean {
	return state === "done" || state === "abandoned";
}
