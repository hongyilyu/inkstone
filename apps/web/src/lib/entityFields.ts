// The single source of truth for the entity FIELD SURFACE: the status/unit/anchor
// value domains, the `{value,label}` option arrays the editors render, and the
// three pure coercers
// (parseAliases/asTodoStatus/asProjectStatus). A PURE LEAF — it imports nothing
// (no React, no lucide, no libraryItems/entityCodec/components), so every
// consumer (codec, proposalEdit, intentGraphReview, the rail editors, the
// proposal card) reads ONE answer for "how is a Todo's status spelled, what
// recurrence units exist, what does the recur-anchor union look like".

/** The Todo GTD status domain, value + display label (ADR-0031). */
export const TODO_STATUSES = [
	{ value: "active", label: "Active" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
] as const;

/** The Project GTD status domain — note `on_hold`, which Todo lacks (ADR-0031). */
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

/** The recurrence unit domain, value + display label (ADR-0037/0039). */
export const RECURRENCE_UNITS = [
	{ value: "minute", label: "Minutes" },
	{ value: "hour", label: "Hours" },
	{ value: "day", label: "Days" },
	{ value: "week", label: "Weeks" },
	{ value: "month", label: "Months" },
	{ value: "year", label: "Years" },
] as const;

/** The recurrence anchor domain — which date the next occurrence counts from. */
export const RECUR_ANCHORS = [
	{ value: "defer_at", label: "Defer date" },
	{ value: "due_at", label: "Due date" },
] as const;

/**
 * The Todo Person-Reference role domain, value + display label (ADR-0031/0032).
 * `TodoPersonRole` stays the canonical type in `libraryItems.ts`; this pure leaf
 * imports nothing, so the `satisfies` pins only the `{value,label}` SHAPE — the
 * two role strings must match the `TodoPersonRole` union by hand (keep them in
 * sync if a role is ever added).
 */
export const TODO_PERSON_ROLES = [
	{ value: "waiting_on", label: "Waiting on" },
	{ value: "related", label: "Related" },
] as const satisfies readonly { value: string; label: string }[];

export type TodoStatus = (typeof TODO_STATUSES)[number]["value"];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]["value"];
export type MediaMedium = (typeof MEDIA_MEDIUMS)[number]["value"];
export type MediaState = (typeof MEDIA_STATES)[number]["value"];
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number]["value"];
export type RecurAnchor = (typeof RECUR_ANCHORS)[number]["value"];

// The option arrays the `<EditorSelect>` call sites map over. Each canonical
// array already IS `[{value,label}]`, so the option arrays simply alias the
// canonical arrays under the names the call sites use.
export const TODO_STATUS_OPTIONS = TODO_STATUSES;
export const PROJECT_STATUS_OPTIONS = PROJECT_STATUSES;
export const MEDIA_MEDIUM_OPTIONS = MEDIA_MEDIUMS;
export const MEDIA_STATE_OPTIONS = MEDIA_STATES;
export const RECURRENCE_UNIT_OPTIONS = RECURRENCE_UNITS;
export const RECUR_ANCHOR_OPTIONS = RECUR_ANCHORS;
export const TODO_PERSON_ROLE_OPTIONS = TODO_PERSON_ROLES;

/** Parse a comma-separated aliases/field string into a trimmed, non-empty `string[]`. */
export function parseAliases(raw: string): string[] {
	return raw
		.split(",")
		.map((a) => a.trim())
		.filter((a) => a.length > 0);
}

/** Coerce an unknown to a Todo status, degrading anything unrecognized to "active". */
export function asTodoStatus(value: unknown): TodoStatus {
	return value === "completed" || value === "dropped" ? value : "active";
}

/** Coerce an unknown to a Project status, degrading anything unrecognized to "active". */
export function asProjectStatus(value: unknown): ProjectStatus {
	return value === "on_hold" || value === "completed" || value === "dropped"
		? value
		: "active";
}

/** Coerce an unknown to a Media medium, degrading anything unrecognized to "link"
 * (the migration's bookmark→media default — a sparse/legacy row never crashes). */
export function asMediaMedium(value: unknown): MediaMedium {
	return MEDIA_MEDIUMS.some((m) => m.value === value)
		? (value as MediaMedium)
		: "link";
}

/** Coerce an unknown to a Media state, degrading anything unrecognized to "done"
 * (the migration's bookmark→media default — a sparse/legacy row never crashes). */
export function asMediaState(value: unknown): MediaState {
	return MEDIA_STATES.some((s) => s.value === value)
		? (value as MediaState)
		: "done";
}
