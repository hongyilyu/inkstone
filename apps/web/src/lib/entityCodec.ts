import {
	type EntityMutateParams,
	type JsonObject,
	type JsonValue,
	readJournalEntryData,
	readMediaData,
	readPersonData,
	readProjectData,
} from "@inkstone/protocol";
import { Schema as S } from "effect";
import {
	asMediaMedium,
	asMediaState,
	asProjectStatus,
	isMediaTerminalState,
	type MediaMedium,
	type MediaState,
	type ProjectStatus,
	parseAliases,
	stampStatusTimestamps,
} from "@/lib/entityFields";
import {
	type EntitySource,
	type JournalEntry,
	type JournalEntryBodyNode,
	localNowString,
	type Media,
	type Person,
	type Project,
} from "@/lib/libraryItems";
import {
	asArray,
	asNumber,
	asObject,
	asString,
	asStringArray,
} from "@/lib/readPayload";

// The relaxed read-data schemas (@inkstone/protocol) own each Entity Type's
// stored `data` FIELD-SET; `readSchemas.test.ts` pins the gated pair as a
// superset of the write `*_core`. The codec decodes `row.data` against them
// (lenient — every field `S.optional(S.Unknown)`, unknown keys ignored) and then
// COERCES the loose values to the view model below. A decode is total ONLY over a
// plain object, so `dataObject()` first coerces a null / array / non-object `data`
// to `{}` — that guard is what keeps the three fail-soft parsers from ever throwing.
const decodePersonData = S.decodeUnknownSync(readPersonData);
const decodeProjectData = S.decodeUnknownSync(readProjectData);
const decodeMediaData = S.decodeUnknownSync(readMediaData);
const decodeJournalEntryData = S.decodeUnknownSync(readJournalEntryData);

// The per-Entity-Type wire codec. THIS module owns each kind's row-input shape
// and BOTH directions: PARSE (row → view-model) and BUILD (draft → mutation
// payload). `hooks/useLibraryItems.ts` consumes the `parse*` functions to map
// live Core rows into Library view-models.

export interface LiveEntityRow {
	readonly id: string;
	readonly data: JsonValue;
	readonly created_at: number;
	readonly refs?: readonly LiveResolvedEntityRef[];
	readonly source?: LiveEntitySource;
}

/** The flat wire provenance shape (ADR-0030); exactly one source kind is set. */
export interface LiveEntitySource {
	readonly thread_id?: string;
	readonly thread_title?: string;
	readonly message_id?: string;
	readonly journal_entry_id?: string;
}

export interface LiveResolvedEntityRef {
	readonly id: string;
	readonly source_entity_id: string;
	readonly target_entity_id: string;
	readonly target_entity_type: "person" | "project";
	readonly target_title?: string;
	readonly label_snapshot?: string;
}

/** A non-empty string id, or undefined — an empty id is treated as absent. */
function nonEmptyId(value: JsonValue | undefined): string | undefined {
	const id = asString(value);
	return id !== undefined && id.trim() !== "" ? id : undefined;
}

/**
 * Map the flat wire provenance (ADR-0030) to the view-model `EntitySource`
 * union. Reads `journal_entry_id` first, else the Thread fields — the same
 * precedence Core's exactly-one-kind row guarantees. Returns undefined for a
 * user-authored Entity (no source) or a malformed/empty source (incl. an
 * empty-string id, which would otherwise emit a dead link), so a thin row can
 * never crash the inspector or render a link that navigates nowhere.
 */
function parseSource(
	source: LiveEntitySource | undefined,
): EntitySource | undefined {
	if (!source) return undefined;
	const journalEntryId = nonEmptyId(source.journal_entry_id);
	if (journalEntryId !== undefined) {
		return { kind: "journal_entry", journalEntryId };
	}
	const threadId = nonEmptyId(source.thread_id);
	if (threadId !== undefined) {
		return {
			kind: "thread",
			threadId,
			threadTitle: source.thread_title ?? "",
			messageId: nonEmptyId(source.message_id),
		};
	}
	return undefined;
}

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// Unlike the four fail-soft parsers, parseJournalEntry stays STRICT: it throws on
// a malformed entry (bad occurred_at, empty/ill-formed body). The decode below
// only bounds the field-SET it reads; the value-level rules `S.Unknown` can't
// express stay as the inline throws. `useLibraryItems` catches the throw and
// drops the row so one bad entry never blanks the whole Library (slice-3).
function parseJournalEntry(row: LiveEntityRow): JournalEntry {
	const data = decodeJournalEntryData(dataObject(row));
	const occurredAt = asString(data.occurred_at);
	if (occurredAt === undefined || !LOCAL_DATETIME_RE.test(occurredAt)) {
		throw new Error(
			`Invalid journal_entry ${row.id}: occurred_at must use YYYY-MM-DDTHH:MM:SS`,
		);
	}
	const nodes = asArray(data.body);
	if (nodes.length === 0) {
		throw new Error(`Invalid journal_entry ${row.id}: body must not be empty`);
	}
	const refsById = new Map((row.refs ?? []).map((ref) => [ref.id, ref]));
	const body: JournalEntryBodyNode[] = nodes.map((node) => {
		const record = asObject(node);
		if (record === null) {
			throw new Error(
				`Invalid journal_entry ${row.id}: body nodes must be objects`,
			);
		}
		if (record.type === "entity_ref") {
			const refId = asString(record.ref_id);
			if (refId === undefined || refId.trim() === "") {
				throw new Error(
					`Invalid journal_entry ${row.id}: entity_ref ref_id must not be empty`,
				);
			}
			const ref = refsById.get(refId);
			return {
				type: "entity_ref",
				refId,
				targetEntityId: ref?.target_entity_id,
				targetKind: ref?.target_entity_type,
				targetTitle: ref?.target_title,
				labelSnapshot: ref?.label_snapshot,
			};
		}
		if (record.type !== "text") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body supports only text or entity_ref nodes`,
			);
		}
		const text = asString(record.text);
		if (text === undefined || text.trim() === "") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body text must not be empty`,
			);
		}
		return { type: "text", text };
	});
	return {
		id: row.id,
		kind: "journal_entry",
		occurredAt,
		// Carry a stored `ended_at` so the editor's full-replace update can
		// round-trip it instead of dropping it (slice-8 trap).
		endedAt: asString(data.ended_at),
		body,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies JournalEntry;
}

/** A row's stored `data` blob as a JSON object for decoding — `{}` when Core sent a
 * null / array / non-object `data`, so a decode (and the coercion below) can never
 * throw on a malformed row. An ARRAY degrades too: an `S.Struct` decode rejects a
 * top-level array, so passing one through would throw and the fail-soft parsers
 * would drop the row instead of defaulting it. */
function dataObject(row: LiveEntityRow): JsonObject {
	return asObject(row.data) ?? {};
}

/** Map a live `entity/list` row to the Library `Person` view model (ADR-0031). */
function parsePerson(row: LiveEntityRow): Person {
	const data = decodePersonData(dataObject(row));
	const aliases = asStringArray(data.aliases);
	return {
		id: row.id,
		kind: "person",
		name: asString(data.name) ?? "Unnamed",
		note: asString(data.note),
		aliases: aliases.length > 0 ? aliases : undefined,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Person;
}

function parseProject(row: LiveEntityRow): Project {
	const data = decodeProjectData(dataObject(row));
	// Carry the complete stored object verbatim so the editor can build a
	// full-document-replace `update_project` without dropping server-managed
	// fields the projection above omits (slice-7). This reads `row.data` directly,
	// NOT the decoded fields — the decode strips unknown keys, but the verbatim
	// passthrough must keep them (e.g. a legacy `review_every: "P1W"` the schema
	// can't model) so update_project's full-replace round-trips. `asRecord` shares
	// the same null/array/non-object guard as the decode above.
	const rawData = { ...dataObject(row) };
	return {
		id: row.id,
		kind: "project",
		name: asString(data.name) ?? "Untitled",
		status: asProjectStatus(data.status),
		outcome: asString(data.outcome),
		note: asString(data.note),
		nextReviewAt: asString(data.next_review_at),
		lastReviewedAt: asString(data.last_reviewed_at),
		data: rawData,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Project;
}

/**
 * Map a live `entity/list` row to the Library `Media` view model (ADR-0059).
 * DEFAULT-TOLERANT: `medium`/`state` degrade to the migration's bookmark→media
 * defaults (`link`/`done`) via the coercers, and every other field is defensively
 * defaulted, so a sparse / pre-migration row cannot crash the inspector. `rating`
 * is kept only when a number; `finished_at` only when a string.
 */
function parseMedia(row: LiveEntityRow): Media {
	const data = decodeMediaData(dataObject(row));
	const tags = asStringArray(data.tags);
	return {
		id: row.id,
		kind: "media",
		title: asString(data.title) ?? "Untitled",
		medium: asMediaMedium(data.medium),
		state: asMediaState(data.state),
		rating: asNumber(data.rating),
		finishedAt: asString(data.finished_at),
		url: asString(data.url),
		note: asString(data.note),
		tags: tags.length > 0 ? tags : undefined,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Media;
}

/**
 * Parse a set of live rows, DROPPING (and warning about) any row that throws.
 * `parseJournalEntry` is strict — it throws on a malformed entry — and a read maps
 * many rows into one list, so an un-guarded throw would reject the whole read and
 * blank everything, not just the bad row. Dropping the offender keeps the rest
 * renderable; the `console.warn` ensures it isn't lost silently (a plain browser
 * diagnostic — Web capture is out of the ADR-0038 trail). The fail-soft parsers
 * never throw, so they always pass through. The single owner of this decode policy
 * for every `entity/*` read hook (`useLibraryItems`, `useEntityBacklinks`).
 */
export function parseRowsDroppingMalformed<T>(
	kind: string,
	rows: readonly LiveEntityRow[],
	parse: (row: LiveEntityRow) => T,
): T[] {
	const items: T[] = [];
	for (const row of rows) {
		try {
			items.push(parse(row));
		} catch (error) {
			console.warn(`Dropping unparseable ${kind} row ${row.id}:`, error);
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// BUILD direction (draft → mutation payload). The codec OWNS each kind's
// draft↔wire mapping — "one place" for the wire shape.
// ---------------------------------------------------------------------------

/** A `YYYY-MM-DD` UI date → the `YYYY-MM-DDTHH:MM:SS` wall-clock string Core wants. */
function dayToLocal(day: string): string {
	return `${day}T00:00:00`;
}

// ---------------------------------------------------------------------------
// PERSON build (full-document replace). Create OMITS empty optionals (Core
// rejects explicit-null on create); update is a full-document REPLACE driven by
// the draft (name always — the validator requires it — plus non-empty
// note/aliases), with a cleared optional simply OMITTED (omit ≡ null under
// replace — never sentinel-null). Returns null when nothing changed.
// ---------------------------------------------------------------------------

/** The editable shape of a Person's scalar fields; `""` means absent/cleared. */
export interface PersonDraft {
	name: string;
	note: string;
	/** Aliases as a comma-separated string; split on save (ADR-0031). */
	aliases: string;
}

/** The editable draft for a Person (or a fresh blank draft when absent). */
function personDraftFromVm(person: Person | undefined): PersonDraft {
	return {
		name: person?.name ?? "",
		note: person?.note ?? "",
		aliases: person?.aliases?.join(", ") ?? "",
	};
}

function buildPersonCreate(d: PersonDraft): EntityMutateParams {
	const payload: JsonObject = {};
	payload.name = d.name.trim();
	if (d.note.trim()) payload.note = d.note.trim();
	const aliases = parseAliases(d.aliases);
	if (aliases.length > 0) payload.aliases = aliases;
	return { mutation_kind: "create_person", payload };
}

function buildPersonUpdate(
	person: Person,
	prev: PersonDraft,
	next: PersonDraft,
): EntityMutateParams | null {
	const changed =
		next.name.trim() !== prev.name ||
		next.note.trim() !== prev.note ||
		next.aliases.trim() !== prev.aliases;
	if (!changed) return null;

	const payload: JsonObject = {};
	payload.entity_id = person.id;
	payload.name = next.name.trim();
	const note = next.note.trim();
	if (note) payload.note = note;
	const aliases = parseAliases(next.aliases);
	if (aliases.length > 0) payload.aliases = aliases;
	return { mutation_kind: "update_person", payload };
}

/** The single PERSON build entry the editor calls: dispatches on `mode`. */
function buildPerson(
	input:
		| { mode: "create"; draft: PersonDraft }
		| {
				mode: "update";
				existing: Person;
				baseline: PersonDraft;
				draft: PersonDraft;
		  },
): EntityMutateParams | null {
	return input.mode === "create"
		? buildPersonCreate(input.draft)
		: buildPersonUpdate(input.existing, input.baseline, input.draft);
}

// ---------------------------------------------------------------------------
// MEDIA build (full-document replace) — uses the ungated media schema (ADR-0059).
// Same full-replace shape as person: title/medium/state always (the validator
// requires them), url/note/tags/rating/finished_at when non-empty, a cleared
// optional OMITTED (omit ≡ null under replace — never sentinel-null, so the built
// payload conforms to `createMedia`/`updateMedia`). CRITICAL: `rating` +
// `finished_at` are emitted ONLY in a terminal state (done/abandoned) — Core
// rejects them otherwise — so a non-terminal state drops them even if the draft
// still holds stale values. Returns null when nothing changed.
// ---------------------------------------------------------------------------

/** The editable shape of a Media item's scalar fields; `""` means absent/cleared. */
export interface MediaDraft {
	title: string;
	medium: MediaMedium;
	state: MediaState;
	/** Rating as text, coerced to a number on build; only used in a terminal state. */
	rating: string;
	/** Finished date as a `YYYY-MM-DD` UI date; only used in a terminal state. */
	finishedDay: string;
	url: string;
	note: string;
	/** Tags as a comma-separated string; split on save (ADR-0059). */
	tags: string;
}

/** Parse the comma-separated tags field into a deduped, trimmed `string[]`. */
function parseTags(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(",")
				.map((t) => t.trim())
				.filter((t) => t.length > 0),
		),
	];
}

/** The editable draft for a Media item (or a fresh blank draft when absent). */
function mediaDraftFromVm(media: Media | undefined): MediaDraft {
	return {
		title: media?.title ?? "",
		medium: media?.medium ?? "link",
		state: media?.state ?? "backlog",
		rating: media?.rating != null ? String(media.rating) : "",
		finishedDay: media?.finishedAt ? media.finishedAt.slice(0, 10) : "",
		url: media?.url ?? "",
		note: media?.note ?? "",
		tags: media?.tags?.join(", ") ?? "",
	};
}

/**
 * The shared full-document body for create/update: title/medium/state always,
 * url/note/tags when non-empty, and rating/finished_at ONLY in a terminal state.
 * `rating` is coerced to a number (dropped when not a finite number); a draft's
 * `finishedDay` folds to a `T00:00:00` wall-clock string. Off-terminal, both are
 * omitted regardless of the draft — Core rejects them in a non-terminal state.
 */
function buildMediaDoc(d: MediaDraft): JsonObject {
	const doc: JsonObject = {};
	doc.title = d.title.trim();
	doc.medium = d.medium;
	doc.state = d.state;
	if (isMediaTerminalState(d.state)) {
		// Clamp to the ADR-0059 contract (integer 1–5) before emitting — the
		// `<input min/max>` in MediaEditor doesn't block pasted/scripted values, and
		// these ungated schemas are the codec's only round-trip guard, so an
		// out-of-range rating would otherwise reach Core (which rejects it) instead
		// of being dropped here.
		const rating = Number(d.rating);
		if (
			d.rating.trim() !== "" &&
			Number.isInteger(rating) &&
			rating >= 1 &&
			rating <= 5
		) {
			doc.rating = rating;
		}
		if (d.finishedDay) doc.finished_at = dayToLocal(d.finishedDay);
	}
	if (d.url.trim()) doc.url = d.url.trim();
	if (d.note.trim()) doc.note = d.note.trim();
	const tags = parseTags(d.tags);
	if (tags.length > 0) doc.tags = tags;
	return doc;
}

function buildMediaCreate(d: MediaDraft): EntityMutateParams {
	return { mutation_kind: "create_media", payload: buildMediaDoc(d) };
}

function buildMediaUpdate(
	media: Media,
	prev: MediaDraft,
	next: MediaDraft,
): EntityMutateParams | null {
	// Compare the BUILT docs, not the raw drafts: the doc trims title/url/note,
	// canonicalizes tags, and clamps rating, while `prev` is seeded untrimmed from
	// the stored item (mediaDraftFromVm). A raw-field compare would mark a stored
	// " Dune " as changed the moment the editor opens, writing on a bare Save.
	const changed =
		JSON.stringify(buildMediaDoc(next)) !== JSON.stringify(buildMediaDoc(prev));
	if (!changed) return null;

	return {
		mutation_kind: "update_media",
		payload: { entity_id: media.id, ...buildMediaDoc(next) },
	};
}

/** The single MEDIA build entry the editor calls: dispatches on `mode`. */
function buildMedia(
	input:
		| { mode: "create"; draft: MediaDraft }
		| {
				mode: "update";
				existing: Media;
				baseline: MediaDraft;
				draft: MediaDraft;
		  },
): EntityMutateParams | null {
	return input.mode === "create"
		? buildMediaCreate(input.draft)
		: buildMediaUpdate(input.existing, input.baseline, input.draft);
}

// ---------------------------------------------------------------------------
// PROJECT build (full-document replace with VERBATIM-data overlay). Create OMITS
// empty optionals (review_every is never sent — Core injects the default review
// ritual). Update CLONES the verbatim stored `project.data` (the slice-2 parse
// carry), deletes `entity_id`, overlays name/outcome/note/status, on a status
// CHANGE sets/clears the terminal timestamps, then DROPS undefined/null keys
// (omit ≡ null under replace) — so server-managed `review_every`/`due_at`/
// `defer_at` survive the overlay. `entity_id` rides at the top level. Returns
// null when nothing changed.
// ---------------------------------------------------------------------------

/**
 * The editable shape of a Project's scalar fields; `""` means absent/cleared.
 * (`due_at`/`defer_at` and the review ritual aren't editable in this form, but
 * the update replays them verbatim from the stored data — ADR-0031.)
 */
export interface ProjectDraft {
	name: string;
	outcome: string;
	note: string;
	status: ProjectStatus;
}

/** The editable draft for a Project (or a fresh blank draft when absent). */
function projectDraftFromVm(project: Project | undefined): ProjectDraft {
	return {
		name: project?.name ?? "",
		outcome: project?.outcome ?? "",
		note: project?.note ?? "",
		status: project?.status ?? "active",
	};
}

function buildProjectCreate(d: ProjectDraft): EntityMutateParams {
	const payload: JsonObject = {};
	payload.name = d.name.trim();
	if (d.outcome.trim()) payload.outcome = d.outcome.trim();
	if (d.note.trim()) payload.note = d.note.trim();
	if (d.status !== "active") {
		payload.status = d.status;
		if (d.status === "completed") payload.completed_at = localNowString();
		else if (d.status === "dropped") payload.dropped_at = localNowString();
	}
	return { mutation_kind: "create_project", payload };
}

function buildProjectUpdate(
	project: Project,
	prev: ProjectDraft,
	next: ProjectDraft,
): EntityMutateParams | null {
	const changed =
		next.name.trim() !== prev.name ||
		next.outcome.trim() !== prev.outcome ||
		next.note.trim() !== prev.note ||
		next.status !== prev.status;
	if (!changed) return null;

	// Clone the complete stored data verbatim, then overlay the form edits. The
	// stored data never carries `entity_id` (Core strips it), but drop it
	// defensively so it rides only as the top-level row target.
	const doc = { ...project.data };
	delete doc.entity_id;

	doc.name = next.name.trim();
	const outcome = next.outcome.trim();
	if (outcome) doc.outcome = outcome;
	else delete doc.outcome;
	const note = next.note.trim();
	if (note) doc.note = note;
	else delete doc.note;
	doc.status = next.status;
	// Only (re)stamp the terminal timestamp(s) on a status CHANGE. When status is
	// unchanged, leave the stored `completed_at`/`dropped_at` (cloned from
	// `project.data`) intact — re-stamping every edit would silently overwrite the
	// original completion/drop date (ADR-0033).
	if (next.status !== prev.status) {
		stampStatusTimestamps(doc, next.status, localNowString());
	}

	// Drop cleared optionals: under full-replace, an absent key carries no value
	// (omit ≡ null — ADR-0033).
	const payload: JsonObject = {};
	payload.entity_id = project.id;
	for (const [key, value] of Object.entries(doc)) {
		if (value !== null) payload[key] = value;
	}
	return { mutation_kind: "update_project", payload };
}

/** The single PROJECT build entry the editor calls: dispatches on `mode`. */
function buildProject(
	input:
		| { mode: "create"; draft: ProjectDraft }
		| {
				mode: "update";
				existing: Project;
				baseline: ProjectDraft;
				draft: ProjectDraft;
		  },
): EntityMutateParams | null {
	return input.mode === "create"
		? buildProjectCreate(input.draft)
		: buildProjectUpdate(input.existing, input.baseline, input.draft);
}

// ---------------------------------------------------------------------------
// JOURNAL_ENTRY build (full replace + a SEPARATE reference weave). The codec
// produces the wire PAYLOADS — create/update full-replace bodies, and the
// reference body for a staged new chip. The editor KEEPS the async orchestration
// (await update-if-scalarsDiffer, then await reference, then dropStagedPlaceholder)
// and the React state/handlers — that's mutation-lifecycle logic, not wire shape.
// ---------------------------------------------------------------------------

/** The Entity kinds an inline chip may target (ADR-0030; never a Journal Entry). */
export type ReferenceableKind = "person" | "project";
export const REFERENCEABLE_KINDS: ReferenceableKind[] = ["person", "project"];

/**
 * The editable body: text segments are mutable strings; chips are references.
 * Existing chips carry a real `refId`; a NEWLY added chip is a bare placeholder
 * carrying its `newTargetId` (no ref_id — Core mints one on the reference
 * mutation). At most one new chip is staged at a time (one reference mutation
 * per new chip — the hard contract). Discriminated on `type`.
 */
export type DraftEntityRefNode = {
	type: "entity_ref";
	/** For existing chips: the stored `ref_id` (snake_case on the wire). */
	refId?: string;
	/** A human label for the chip token. */
	label?: string;
	/** For a NEW chip: the picked Entity's id (the reference target). */
	newTargetId?: string;
};

type StagedEntityRefNode = DraftEntityRefNode & { newTargetId: string };

export type DraftBodyNode = { type: "text"; text: string } | DraftEntityRefNode;

export interface JournalDraft {
	/** Local wall-clock `YYYY-MM-DDTHH:MM` (datetime-local value). */
	occurredAt: string;
	endedAt: string;
	body: DraftBodyNode[];
}

/** A 16-char datetime-local value (`…THH:MM`) → the 19-char string Core wants. */
function localToWallClock(value: string): string {
	return `${value}:00`;
}

/** A stored 19-char wall-clock string → the 16-char datetime-local value. */
function wallClockToLocal(value: string): string {
	return value.slice(0, 16);
}

/**
 * Resolve the wall-clock string to emit for a time the user may not have touched.
 * `datetime-local` only carries minute precision, so a stored value with nonzero
 * seconds would be re-stamped to `:00` on any save — silent mutation of an
 * untouched field. When the input still matches the stored value's minute prefix,
 * emit the stored string verbatim (seconds preserved); otherwise emit the edit.
 */
function emitWallClock(value: string, stored: string | undefined): string {
	if (stored && wallClockToLocal(stored) === value) return stored;
	return localToWallClock(value);
}

function chipLabel(
	node: Extract<JournalEntryBodyNode, { type: "entity_ref" }>,
) {
	return node.targetTitle ?? node.labelSnapshot ?? "Referenced entity";
}

/** The editable draft for a Journal Entry (or a fresh blank draft when absent). */
function journalDraftFromVm(entry: JournalEntry | undefined): JournalDraft {
	if (!entry) {
		return {
			occurredAt: wallClockToLocal(localNowString()),
			endedAt: "",
			body: [{ type: "text", text: "" }],
		};
	}
	return {
		occurredAt: wallClockToLocal(entry.occurredAt),
		endedAt: entry.endedAt ? wallClockToLocal(entry.endedAt) : "",
		body: entry.body.map((node) =>
			node.type === "text"
				? { type: "text", text: node.text }
				: { type: "entity_ref", refId: node.refId, label: chipLabel(node) },
		),
	};
}

/**
 * The wire body for the draft, dropping empty text segments and mapping kept
 * chips to snake_case `{type:"entity_ref", ref_id}` carrying the REAL stored id
 * (slice-6 bug class — never leak camelCase `refId`). Empty when nothing remains.
 */
function buildBody(
	body: DraftBodyNode[],
): Array<
	{ type: "text"; text: string } | { type: "entity_ref"; ref_id: string }
> {
	const nodes: Array<
		{ type: "text"; text: string } | { type: "entity_ref"; ref_id: string }
	> = [];
	for (const node of body) {
		if (node.type === "text") {
			if (node.text.trim() !== "")
				nodes.push({ type: "text", text: node.text });
		} else if (node.refId) {
			nodes.push({ type: "entity_ref", ref_id: node.refId });
		}
	}
	return nodes;
}

function buildJournalEntryCreate(d: JournalDraft): EntityMutateParams {
	const payload: JsonObject = {};
	payload.occurred_at = localToWallClock(d.occurredAt);
	payload.body = buildBody(d.body);
	if (d.endedAt) payload.ended_at = localToWallClock(d.endedAt);
	return { mutation_kind: "create_journal_entry", payload };
}

/**
 * `update_journal_entry` is a FULL REPLACE (slice-8): emit the complete intended
 * state — occurred_at, ended_at (when set), and the whole body (kept chips +
 * edited text). A removed chip is simply absent from `body`.
 */
function buildJournalEntryUpdate(
	entry: JournalEntry,
	d: JournalDraft,
): EntityMutateParams {
	const payload: JsonObject = {};
	payload.entity_id = entry.id;
	payload.occurred_at = emitWallClock(d.occurredAt, entry.occurredAt);
	payload.body = buildBody(d.body);
	if (d.endedAt) payload.ended_at = emitWallClock(d.endedAt, entry.endedAt);
	return { mutation_kind: "update_journal_entry", payload };
}

/**
 * The JOURNAL_ENTRY full-replace build entry the editor calls: dispatches on
 * `mode`. (The reference weave for a staged new chip is `buildJournalReference`;
 * the editor sequences the two.)
 */
function buildJournalEntry(
	input:
		| { mode: "create"; draft: JournalDraft }
		| { mode: "update"; existing: JournalEntry; draft: JournalDraft },
): EntityMutateParams {
	return input.mode === "create"
		? buildJournalEntryCreate(input.draft)
		: buildJournalEntryUpdate(input.existing, input.draft);
}

/** The single staged new chip (the one bare placeholder), or undefined. */
function stagedNewChip(body: DraftBodyNode[]): StagedEntityRefNode | undefined {
	return body.find(
		(node): node is StagedEntityRefNode =>
			node.type === "entity_ref" && node.newTargetId !== undefined,
	);
}

/**
 * Whether the draft's occurred_at/ended_at differ from the stored entry. The
 * reference mutation (`buildJournalReference`) carries NO scalars — Core preserves
 * the stored occurred_at/ended_at and replaces only the body. So when a chip is
 * staged AND the user also edited a date in the same Save, the scalar edit would
 * be silently dropped unless we first emit an `update_journal_entry` for it.
 */
function journalScalarsDiffer(entry: JournalEntry, d: JournalDraft): boolean {
	if (emitWallClock(d.occurredAt, entry.occurredAt) !== entry.occurredAt)
		return true;
	const ended = d.endedAt ? emitWallClock(d.endedAt, entry.endedAt) : undefined;
	return ended !== entry.endedAt;
}

/**
 * The wire body for a reference mutation: the JE's text nodes plus the ONE new
 * chip as a BARE `{type:"entity_ref"}` placeholder (Core mints its ref_id and
 * rewrites the placeholder). Core rejects any `ref_id` on a reference body node
 * and rewrites EVERY placeholder to the same minted id, so this body carries no
 * `ref_id` node and exactly one placeholder. Add-a-chip is gated to chip-free
 * entries (see `AddReferenceField`), so no existing chip is ever present here.
 */
function buildReferenceBody(
	body: DraftBodyNode[],
): Array<{ type: "text"; text: string } | { type: "entity_ref" }> {
	const nodes: Array<{ type: "text"; text: string } | { type: "entity_ref" }> =
		[];
	for (const node of body) {
		if (node.type === "text") {
			if (node.text.trim() !== "")
				nodes.push({ type: "text", text: node.text });
		} else if (node.newTargetId !== undefined) {
			nodes.push({ type: "entity_ref" });
		}
	}
	return nodes;
}

/**
 * `reference_existing_entity_from_journal_entry` for the ONE staged new chip:
 * the JE is the source, the picked Entity the target, and the body carries
 * exactly one bare placeholder for the new chip (ADR-0030/0033).
 */
function buildJournalReference(
	entry: JournalEntry,
	d: JournalDraft,
	chip: StagedEntityRefNode,
): EntityMutateParams {
	const payload: JsonObject = {};
	payload.source_entity_id = entry.id;
	payload.target_entity_id = chip.newTargetId;
	payload.body = buildReferenceBody(d.body);
	if (chip.label) payload.label_snapshot = chip.label;
	return {
		mutation_kind: "reference_existing_entity_from_journal_entry",
		payload,
	};
}

export {
	buildBody,
	buildJournalEntry,
	buildJournalReference,
	buildMedia,
	buildPerson,
	buildProject,
	journalDraftFromVm,
	journalScalarsDiffer,
	mediaDraftFromVm,
	parseJournalEntry,
	parseMedia,
	parsePerson,
	parseProject,
	personDraftFromVm,
	projectDraftFromVm,
	stagedNewChip,
};
