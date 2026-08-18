import {
	asProjectStatus,
	type ProjectStatus,
	parseAliases,
	stampStatusTimestamps,
} from "@/lib/entityFields";
import { localNowString } from "@/lib/libraryItems";
import { readString, readStringArray } from "@/lib/readPayload";

// Pure overlay builders for the Proposal review card's inline GTD edit (ADR-0025).
//
// Per editable kind: `seed(payload) → draft` reads the surfaced fields out of the
// (unvalidated) proposed payload, and `overlay(payload, draft) → editedPayload`
// returns a CLONE of the proposed payload with ONLY the surfaced fields
// overwritten. Everything the form doesn't surface rides untouched — for
// a create_person that means `source_journal_entry_id`, and every unsurfaced field.
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
// The 4 GTD wire kinds collapse to 2 behavior variants: update_person and
// update_project are FULL-DOCUMENT REPLACE that surface the same fields as their
// create twins, so they reuse the create seed/overlay directly and share the create
// variant — nothing downstream distinguishes the twins.
// ---------------------------------------------------------------------------

export type GtdEditVariant = "person" | "project";

const GTD_EDIT_VARIANTS: Record<string, GtdEditVariant> = {
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
