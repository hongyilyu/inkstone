import {
	asProjectStatus,
	asTodoStatus,
	type ProjectStatus,
	parseAliases,
	stampStatusTimestamps,
	type TodoStatus,
} from "@/lib/entityFields";
import { localNowString } from "@/lib/libraryItems";
import { readObject, readString, readStringArray } from "@/lib/readPayload";

// Pure overlay builders for the Proposal review card's inline GTD edit (ADR-0025).
//
// Per editable kind: `seed(payload) → draft` reads the surfaced fields out of the
// (unvalidated) proposed payload, and `overlay(payload, draft) → editedPayload`
// returns a CLONE of the proposed payload with ONLY the surfaced fields
// overwritten. Everything the form doesn't surface rides untouched — for
// create_todo that means `person_refs` and `source_journal_entry_id`, and within
// `todo{}` every unsurfaced field (project_id, due_at, defer_at, recurrence, …).
//
// This is deliberately NOT `entityCodec.build`: the codec's update build is a
// diff-vs-baseline (it emits sentinel-null clears against a stored entity), which
// is structurally wrong for editing a payload the user is about to create.
//
// The proposed payload is `unknown` — raw model output that may be null, missing
// fields, or wrong-typed — so every read degrades like the shared
// `readString`/`readObject` helpers and never throws.

// ---------------------------------------------------------------------------
// GTD edit-variant resolver — the SINGLE source of GTD-editability. The card's
// editor-selector (`isGtdEditKind`) and the GtdEditForm's per-kind dispatch both
// read it, so there is no second hand-maintained GTD kind list to drift.
//
// The 6 GTD wire kinds collapse to 4 behavior variants: update_person and
// update_project are FULL-DOCUMENT REPLACE that surface the same fields as their
// create twins, so they reuse the create seed/overlay directly and share the create
// variant — nothing downstream distinguishes the twins.
// ---------------------------------------------------------------------------

export type GtdEditVariant =
	| "todo_create"
	| "todo_update"
	| "person"
	| "project";

const GTD_EDIT_VARIANTS: Record<string, GtdEditVariant> = {
	create_todo: "todo_create",
	update_todo: "todo_update",
	create_person: "person",
	update_person: "person",
	create_project: "project",
	update_project: "project",
};

/**
 * Resolve a wire `mutation_kind` to its GTD edit variant, or `null` for every
 * non-GTD kind. Gate on OWN membership (`Object.hasOwn`), not a bare `?? null`:
 * `kind` is an unvalidated wire string (ADR-0014), and indexing the record with a
 * prototype key ("toString", "constructor", …) would return an inherited
 * Object.prototype member — truthy, so `?? null` would NOT fire and the key would
 * wrongly read as editable (mirrors the `proposalView` guard in ProposalCard.tsx).
 */
export function gtdEditVariant(kind: string): GtdEditVariant | null {
	return Object.hasOwn(GTD_EDIT_VARIANTS, kind)
		? GTD_EDIT_VARIANTS[kind]
		: null;
}

/** Whether a wire `mutation_kind` surfaces the GTD inline edit form. */
export function isGtdEditKind(kind: string): boolean {
	return gtdEditVariant(kind) !== null;
}

/**
 * A structured-clone of the proposed payload as a record (`{}` when it is
 * null/non-object), so the overlay can overwrite surfaced keys while every
 * unsurfaced field rides untouched and the caller's payload is never mutated.
 */
function clonePayload(payload: unknown): Record<string, unknown> {
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		return structuredClone(payload) as Record<string, unknown>;
	}
	return {};
}

/** The surfaced, editable fields of a `create_todo`'s `todo{}`. */
export interface CreateTodoDraft {
	title: string;
	note: string;
	status: TodoStatus;
}

/** Seed a create_todo draft from the proposed payload, never throwing. */
export function seedCreateTodo(payload: unknown): CreateTodoDraft {
	const todo = readObject(payload, "todo");
	return {
		title: readString(todo, "title"),
		note: readString(todo, "note"),
		status: asTodoStatus(todo?.status),
	};
}

/**
 * Overlay the create_todo draft onto a CLONE of the proposed payload. Only the
 * surfaced `todo` fields change; `person_refs`, `source_journal_entry_id`, and
 * every unsurfaced `todo` field are preserved byte-for-byte.
 *
 * Status↔timestamp coupling (ADR-0031): when the user CHANGES status, re-stamp
 * the coupled terminal timestamp on `todo{}` — `→completed` sets `completed_at`
 * and deletes `dropped_at`, `→dropped` mirrors, `→active` deletes both. When
 * status is UNCHANGED, the stored `completed_at`/`dropped_at` ride untouched.
 *
 * Omit-empty (ADR-0033): a blank `note` deletes the key (create has no prior to
 * clear, so "no note" is an omission, never a sentinel-null).
 */
export function overlayCreateTodo(
	payload: unknown,
	draft: CreateTodoDraft,
): Record<string, unknown> {
	const next = clonePayload(payload);
	const todo: Record<string, unknown> = {
		...((next.todo && typeof next.todo === "object" && !Array.isArray(next.todo)
			? next.todo
			: {}) as Record<string, unknown>),
	};

	const prevStatus = asTodoStatus(todo.status);

	todo.title = draft.title.trim();

	const note = draft.note.trim();
	if (note) {
		todo.note = note;
	} else {
		delete todo.note;
	}

	todo.status = draft.status;
	// Re-stamp the coupled timestamp only on a status CHANGE; an unchanged status
	// leaves any stored completed_at/dropped_at intact.
	if (draft.status !== prevStatus) {
		stampStatusTimestamps(todo, draft.status, localNowString(), "delete");
	}

	next.todo = todo;
	return next;
}

// ---------------------------------------------------------------------------
// create_person — surfaces Name / Note / Aliases. Aliases edit as a single
// comma-separated string in the form (mirroring the Library PersonEditor and
// entityCodec.parseAliases) and split back to a trimmed, non-empty string[] on
// overlay. The overlay clones the proposed payload and overwrites only the three
// surfaced keys; `source_journal_entry_id` and any unsurfaced field ride
// untouched. A create has no stored prior, so a blank optional is an OMISSION,
// never a sentinel-null (ADR-0033).
// ---------------------------------------------------------------------------

/** The surfaced, editable fields of a `create_person` payload. */
export interface CreatePersonDraft {
	name: string;
	/** Aliases as a comma-separated string; split on overlay. */
	aliases: string;
	note: string;
}

/** Seed a create_person draft from the proposed payload, never throwing. */
export function seedCreatePerson(payload: unknown): CreatePersonDraft {
	return {
		name: readString(payload, "name"),
		note: readString(payload, "note"),
		aliases: readStringArray(payload, "aliases").join(", "),
	};
}

/**
 * Overlay the create_person draft onto a CLONE of the proposed payload. Only the
 * surfaced name/note/aliases change; `source_journal_entry_id` and every
 * unsurfaced field are preserved byte-for-byte.
 *
 * Omit-empty (ADR-0033): a blank `note` or empty `aliases` deletes the key (create
 * has no prior to clear, so "absent" is an omission, never a sentinel-null).
 */
export function overlayCreatePerson(
	payload: unknown,
	draft: CreatePersonDraft,
): Record<string, unknown> {
	const next = clonePayload(payload);

	next.name = draft.name.trim();

	const note = draft.note.trim();
	if (note) {
		next.note = note;
	} else {
		delete next.note;
	}

	const aliases = parseAliases(draft.aliases);
	if (aliases.length > 0) {
		next.aliases = aliases;
	} else {
		delete next.aliases;
	}

	return next;
}

// ---------------------------------------------------------------------------
// create_project — surfaces Name / Outcome / Note / Status. Mirrors create_todo's
// status↔timestamp coupling, but over PROJECT statuses (active / on_hold /
// completed / dropped — note `on_hold`, which Todo lacks). The overlay clones the
// proposed payload and overwrites only the four surfaced keys; provenance
// (`source_journal_entry_id`), the review ritual (`review_every`,
// `next_review_at`, `last_reviewed_at`), and the dates ride untouched. Blank
// optional ⇒ omit (ADR-0033).
// ---------------------------------------------------------------------------

/** The surfaced, editable fields of a `create_project` payload. */
export interface CreateProjectDraft {
	name: string;
	outcome: string;
	note: string;
	status: ProjectStatus;
}

/** Seed a create_project draft from the proposed payload, never throwing. */
export function seedCreateProject(payload: unknown): CreateProjectDraft {
	return {
		name: readString(payload, "name"),
		outcome: readString(payload, "outcome"),
		note: readString(payload, "note"),
		status: asProjectStatus(
			payload && typeof payload === "object"
				? (payload as Record<string, unknown>).status
				: undefined,
		),
	};
}

/**
 * Overlay the create_project draft onto a CLONE of the proposed payload. Only the
 * surfaced name/outcome/note/status change; provenance, the review ritual, and the
 * dates are preserved byte-for-byte.
 *
 * Status↔timestamp coupling (ADR-0031/0033): when the user CHANGES status, re-stamp
 * the coupled terminal timestamp — `→completed` sets `completed_at` and deletes
 * `dropped_at`, `→dropped` mirrors, `→active`/`→on_hold` deletes both (neither is
 * terminal). When status is UNCHANGED, the stored `completed_at`/`dropped_at` ride
 * untouched.
 *
 * Omit-empty (ADR-0033): a blank `outcome` or `note` deletes the key.
 */
export function overlayCreateProject(
	payload: unknown,
	draft: CreateProjectDraft,
): Record<string, unknown> {
	const next = clonePayload(payload);

	const prevStatus = asProjectStatus(next.status);

	next.name = draft.name.trim();

	const outcome = draft.outcome.trim();
	if (outcome) {
		next.outcome = outcome;
	} else {
		delete next.outcome;
	}

	const note = draft.note.trim();
	if (note) {
		next.note = note;
	} else {
		delete next.note;
	}

	next.status = draft.status;
	// Re-stamp the coupled timestamp only on a status CHANGE; an unchanged status
	// leaves any stored completed_at/dropped_at intact.
	if (draft.status !== prevStatus) {
		stampStatusTimestamps(next, draft.status, localNowString(), "delete");
	}

	return next;
}

// ---------------------------------------------------------------------------
// update_todo — the SUBTLE kind: the proposed payload is a PARTIAL, not a full
// entity — `{todo_id, todo?:{…partial}, set_person_refs?, add_person_refs?,
// remove_person_ids?}`. The form edits the `todo{}` partial IN PLACE: `todo_id`
// and all three ref lists pass through byte-for-byte; within `todo{}` only the
// SURFACED keys (title/note, and status only when the partial already carries
// one) are touched and every other proposed key (project_id, due_at, recurrence,
// …) rides untouched.
//
// `titlePresent`/`statusPresent` record whether the partial already carried that
// key, because the surface differs from create_todo:
//   - Status is shown ONLY when the partial proposed a status; surfacing a select
//     that injected a status the model never proposed would add an unrequested
//     field to the partial.
//   - Blanking a proposed optional OMITS it from the partial (delete the key) — it
//     does NOT emit a sentinel-null clear of unseen stored data. The user is
//     declining a proposed change, not reaching past it to erase stored data.
//     (Locked grill decision.)
// ---------------------------------------------------------------------------

/** The surfaced, editable fields of an `update_todo`'s `todo{}` partial. */
export interface UpdateTodoDraft {
	title: string;
	/** Whether the proposed partial carried a `title` key (gates the title field + Save). */
	titlePresent: boolean;
	note: string;
	status: TodoStatus;
	/** Whether the proposed partial carried a `status` key (gates the Status control + coupling). */
	statusPresent: boolean;
}

/** Seed an update_todo draft from the proposed partial, never throwing. */
export function seedUpdateTodo(payload: unknown): UpdateTodoDraft {
	const todo = readObject(payload, "todo");
	return {
		title: readString(todo, "title"),
		titlePresent: todo !== null && "title" in todo,
		note: readString(todo, "note"),
		status: asTodoStatus(todo?.status),
		statusPresent: todo !== null && "status" in todo,
	};
}

/**
 * Overlay the update_todo draft onto a CLONE of the proposed payload, editing the
 * `todo{}` partial IN PLACE. `todo_id`, `set_person_refs`, `add_person_refs`, and
 * `remove_person_ids` pass through byte-for-byte; within `todo{}` only the surfaced
 * keys change and every unsurfaced proposed key (project_id, due_at, recurrence, …)
 * is preserved.
 *
 * Surfaced-key discipline: `title`/`status` are written only when the partial
 * already carried them (`titlePresent`/`statusPresent`) — the form never injects a
 * field the model didn't propose. `note` is always a surfaced field; blanking it
 * omits the key (ADR-0033 — a declined proposed change, never a sentinel-null clear
 * of unseen stored data).
 *
 * Status↔timestamp coupling (ADR-0031): only when status IS surfaced AND CHANGES —
 * `→completed` stamps `completed_at` + deletes `dropped_at`, `→dropped` mirrors,
 * `→active` deletes both — all WITHIN the partial. An unchanged status leaves any
 * proposed completed_at/dropped_at intact.
 */
export function overlayUpdateTodo(
	payload: unknown,
	draft: UpdateTodoDraft,
): Record<string, unknown> {
	const next = clonePayload(payload);
	const todo: Record<string, unknown> = {
		...((next.todo && typeof next.todo === "object" && !Array.isArray(next.todo)
			? next.todo
			: {}) as Record<string, unknown>),
	};

	const prevStatus = asTodoStatus(todo.status);

	if (draft.titlePresent) {
		todo.title = draft.title.trim();
	}

	const note = draft.note.trim();
	if (note) {
		todo.note = note;
	} else {
		delete todo.note;
	}

	if (draft.statusPresent) {
		todo.status = draft.status;
		// Re-stamp the coupled timestamp only on a status CHANGE; an unchanged status
		// leaves any proposed completed_at/dropped_at intact.
		if (draft.status !== prevStatus) {
			if (draft.status === "completed") {
				todo.completed_at = localNowString();
				delete todo.dropped_at;
			} else if (draft.status === "dropped") {
				todo.dropped_at = localNowString();
				delete todo.completed_at;
			} else {
				delete todo.completed_at;
				delete todo.dropped_at;
			}
		}
	}

	next.todo = todo;
	return next;
}

// ---------------------------------------------------------------------------
// update_person / update_project — FULL-DOCUMENT REPLACE. Unlike update_todo (a
// partial), the proposed payload IS the whole new entity body — the create_person/
// create_project shape PLUS a top-level `entity_id` routing key. They surface the
// SAME fields as their create twins (Name/Note/Aliases; Name/Outcome/Note/Status),
// so the card reuses `seedCreatePerson`/`overlayCreatePerson` (resp. project)
// DIRECTLY — no separate update seed/overlay exists. `clonePayload` carries every
// unsurfaced top-level field through untouched: the `entity_id` for both, plus the
// review cadence (`review_every`/`next_review_at`/`last_reviewed_at`) + dates for
// project. Omit-empty (ADR-0033): a blanked optional is OMITTED, not sentinel-null —
// under a full replace, omit ≡ cleared.
// ---------------------------------------------------------------------------
