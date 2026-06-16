import { localNowString } from "@/lib/libraryItems";

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
// fields, or wrong-typed — so every read degrades like the card's own
// `textField`/`objectField` helpers and never throws.

const TODO_STATUSES = ["active", "completed", "dropped"] as const;
export type TodoEditStatus = (typeof TODO_STATUSES)[number];

/** Read `key` off `payload` as a string, degrading anything else to "". */
function readString(payload: unknown, key: string): string {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
	}
	return "";
}

/** Read `key` off `payload` as a plain object, degrading anything else to null. */
function readObject(
	payload: unknown,
	key: string,
): Record<string, unknown> | null {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return null;
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

function asTodoStatus(value: unknown): TodoEditStatus {
	return value === "completed" || value === "dropped" ? value : "active";
}

/** The surfaced, editable fields of a `create_todo`'s `todo{}`. */
export interface CreateTodoDraft {
	title: string;
	note: string;
	status: TodoEditStatus;
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

	next.todo = todo;
	return next;
}
