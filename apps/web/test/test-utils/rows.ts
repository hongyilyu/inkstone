import type { EntityRow } from "@inkstone/protocol";

// Wire-shape `EntityRow` builders (packages/protocol/src/entity.ts:87) for the
// five Library entity types. Each returns the raw row a real `entity/list`
// response carries: `data` holds the type's snake_case fields with sensible
// defaults spread UNDER the caller's partial, so a test states only what it
// asserts on. `RowOpts` carries the row-level optionals (timestamps, refs,
// person_refs, source) migrated tests need to override.

/** Row-level optionals shared by every builder. */
export interface RowOpts {
	created_at?: number;
	updated_at?: number;
	refs?: EntityRow["refs"];
	person_refs?: EntityRow["person_refs"];
	source?: EntityRow["source"];
}

/** Stored Todo `data` fields (mirrors `readTodoData`, payloads.ts:598). */
export interface TodoData {
	title: string;
	note: string;
	status: string;
	project_id: string;
	defer_at: string;
	due_at: string;
	completed_at: string;
	dropped_at: string;
	recurrence: unknown;
}

/** Stored Person `data` fields (mirrors `readPersonData`, payloads.ts:612). */
export interface PersonData {
	name: string;
	note: string;
	aliases: readonly string[];
}

/** Stored Project `data` fields (mirrors `readProjectData`, payloads.ts:622). */
export interface ProjectData {
	name: string;
	outcome: string;
	note: string;
	status: string;
	defer_at: string;
	due_at: string;
	completed_at: string;
	dropped_at: string;
	next_review_at: string;
	last_reviewed_at: string;
	review_every: unknown;
}

/** One Journal Entry body node: `text` or `entity_ref` (ADR-0030). */
export interface JeBodyNode {
	type: string;
	text?: string;
	ref_id?: string;
}

/** Stored Journal Entry `data` fields (mirrors `readJournalEntryData`, payloads.ts:657). */
export interface JeData {
	occurred_at: string;
	ended_at: string;
	body: readonly JeBodyNode[];
}

/** Stored Media `data` fields (mirrors `readMediaData`, payloads.ts:640). */
export interface MediaData {
	title: string;
	medium: string;
	state: string;
	rating: number;
	finished_at: string;
	url: string;
	note: string;
	tags: readonly string[];
}

const EPOCH = 1_700_000_000_000;

function baseRow(
	id: string,
	type: string,
	data: unknown,
	opts: RowOpts,
): EntityRow {
	return {
		id,
		type,
		data,
		created_at: opts.created_at ?? EPOCH,
		updated_at: opts.updated_at ?? EPOCH,
		...(opts.refs !== undefined ? { refs: opts.refs } : {}),
		...(opts.person_refs !== undefined
			? { person_refs: opts.person_refs }
			: {}),
		...(opts.source !== undefined ? { source: opts.source } : {}),
	};
}

/** A wire Todo row; defaults `status: "active"`. */
export function todoRow(
	id: string,
	title: string,
	data: Partial<TodoData> = {},
	opts: RowOpts = {},
): EntityRow {
	return baseRow(id, "todo", { title, status: "active", ...data }, opts);
}

/** A wire Project row; defaults `status: "active"`. */
export function projectRow(
	id: string,
	name: string,
	data: Partial<ProjectData> = {},
	opts: RowOpts = {},
): EntityRow {
	return baseRow(id, "project", { name, status: "active", ...data }, opts);
}

/** A wire Person row. */
export function personRow(
	id: string,
	name: string,
	data: Partial<PersonData> = {},
	opts: RowOpts = {},
): EntityRow {
	return baseRow(id, "person", { name, ...data }, opts);
}

/** A wire Journal Entry row; defaults `occurred_at: "2026-01-01T10:00:00"`. */
export function journalEntryRow(
	id: string,
	body: readonly JeBodyNode[],
	data: Partial<JeData> = {},
	opts: RowOpts = {},
): EntityRow {
	return baseRow(
		id,
		"journal_entry",
		{ occurred_at: "2026-01-01T10:00:00", body, ...data },
		opts,
	);
}

/** A wire Media row. */
export function mediaRow(
	id: string,
	title: string,
	medium: string,
	state: string,
	data: Partial<MediaData> = {},
	opts: RowOpts = {},
): EntityRow {
	return baseRow(id, "media", { title, medium, state, ...data }, opts);
}
