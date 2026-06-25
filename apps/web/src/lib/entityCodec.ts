import {
	type EntityMutateParams,
	readBookmarkData,
	readJournalEntryData,
	readPersonData,
	readProjectData,
	readTodoData,
} from "@inkstone/protocol";
import { Schema as S } from "effect";
import {
	asProjectStatus,
	asTodoStatus,
	type ProjectStatus,
	parseAliases,
	RECURRENCE_UNITS,
	type RecurAnchor,
	type RecurrenceUnit,
	type TodoStatus,
} from "@/lib/entityFields";
import {
	type Bookmark,
	type EntitySource,
	type JournalEntry,
	type JournalEntryBodyNode,
	localNowString,
	type Person,
	type Project,
	type RecurrenceRule,
	type Todo,
	type TodoPersonRole,
} from "@/lib/libraryItems";

// The relaxed read-data schemas (@inkstone/protocol) own each Entity Type's
// stored `data` FIELD-SET; `readSchemas.test.ts` pins the gated trio as a
// superset of the write `*_core`. The codec decodes `row.data` against them
// (lenient — every field `S.optional(S.Unknown)`, unknown keys ignored) and then
// COERCES the loose values to the view model below. A decode is total ONLY over a
// plain object, so `asRecord()` first coerces a null / array / non-object `data`
// to `{}` — that guard is what keeps the four fail-soft parsers from ever throwing
// (an `S.Struct` decode rejects a top-level array, `typeof [] === "object"`).
const decodeTodoData = S.decodeUnknownSync(readTodoData);
const decodePersonData = S.decodeUnknownSync(readPersonData);
const decodeProjectData = S.decodeUnknownSync(readProjectData);
const decodeBookmarkData = S.decodeUnknownSync(readBookmarkData);
const decodeJournalEntryData = S.decodeUnknownSync(readJournalEntryData);

// The per-Entity-Type wire codec. THIS module owns each kind's row-input shape
// and BOTH directions: PARSE (row → view-model) and BUILD (draft → mutation
// payload). `hooks/useLibraryItems.ts` consumes the `parse*` functions to map
// live Core rows into Library view-models.

export interface LiveEntityRow {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
	readonly refs?: readonly LiveResolvedEntityRef[];
	readonly person_refs?: readonly LiveTodoPersonRef[];
	readonly source?: LiveEntitySource;
}

/** The flat wire provenance shape (ADR-0030); exactly one source kind is set. */
export interface LiveEntitySource {
	readonly thread_id?: string;
	readonly thread_title?: string;
	readonly journal_entry_id?: string;
}

export interface LiveTodoPersonRef {
	readonly person_id: string;
	readonly role: "waiting_on" | "related";
}

export interface LiveResolvedEntityRef {
	readonly id: string;
	readonly source_entity_id: string;
	readonly target_entity_id: string;
	readonly target_entity_type: "person" | "project" | "todo";
	readonly target_title?: string;
	readonly label_snapshot?: string;
}

/** A non-empty string id, or undefined — an empty id is treated as absent. */
function nonEmptyId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
			threadTitle:
				typeof source.thread_title === "string" ? source.thread_title : "",
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
	const data = decodeJournalEntryData(asRecord(row.data));
	if (
		typeof data.occurred_at !== "string" ||
		!LOCAL_DATETIME_RE.test(data.occurred_at)
	) {
		throw new Error(
			`Invalid journal_entry ${row.id}: occurred_at must use YYYY-MM-DDTHH:MM:SS`,
		);
	}
	if (!Array.isArray(data.body) || data.body.length === 0) {
		throw new Error(`Invalid journal_entry ${row.id}: body must not be empty`);
	}
	const refsById = new Map((row.refs ?? []).map((ref) => [ref.id, ref]));
	const body: JournalEntryBodyNode[] = data.body.map((node) => {
		if (!node || typeof node !== "object") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body nodes must be objects`,
			);
		}
		const record = node as Record<string, unknown>;
		if (record.type === "entity_ref") {
			if (typeof record.ref_id !== "string" || record.ref_id.trim() === "") {
				throw new Error(
					`Invalid journal_entry ${row.id}: entity_ref ref_id must not be empty`,
				);
			}
			const ref = refsById.get(record.ref_id);
			return {
				type: "entity_ref",
				refId: record.ref_id,
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
		if (typeof record.text !== "string" || record.text.trim() === "") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body text must not be empty`,
			);
		}
		return { type: "text", text: record.text };
	});
	return {
		id: row.id,
		kind: "journal_entry",
		occurredAt: data.occurred_at,
		// Carry a stored `ended_at` so the editor's full-replace update can
		// round-trip it instead of dropping it (slice-8 trap).
		endedAt: typeof data.ended_at === "string" ? data.ended_at : undefined,
		body,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies JournalEntry;
}

/** A stored `data` blob coerced to a record for decoding — `{}` when Core sent a
 * null / array / non-object `data`, so a decode (and the coercion below) can never
 * throw on a malformed row. Arrays are excluded deliberately: `typeof [] ===
 * "object"`, but an `S.Struct` decode rejects a top-level array, so without the
 * `!Array.isArray` guard an array `data` would throw and the fail-soft parsers
 * would drop the row instead of defaulting it. */
function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Defensively map a stored snake_case recurrence rule (ADR-0037, slimmed by
 * ADR-0039) to the camelCase view model. Core validates the rule on the way in,
 * so this is parsing not validation: it returns undefined unless the required
 * fields are present and well-typed, and never throws on a partial/missing shape.
 */
function asRecurrence(value: unknown): RecurrenceRule | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as Record<string, unknown>;
	if (
		typeof r.interval !== "number" ||
		typeof r.unit !== "string" ||
		!RECURRENCE_UNITS.some((u) => u.value === r.unit) ||
		(r.anchor !== "defer_at" && r.anchor !== "due_at")
	) {
		return undefined;
	}
	const rule: RecurrenceRule = {
		interval: r.interval,
		unit: r.unit as RecurrenceUnit,
		anchor: r.anchor,
	};
	if (r.end && typeof r.end === "object") {
		const endRaw = r.end as Record<string, unknown>;
		const end: { until?: string; afterCount?: number } = {};
		if (typeof endRaw.until === "string") end.until = endRaw.until;
		if (typeof endRaw.after_count === "number")
			end.afterCount = endRaw.after_count;
		if (end.until !== undefined || end.afterCount !== undefined) rule.end = end;
	}
	return rule;
}

/** Map a live `entity/list` row to the Library `Todo` view model (ADR-0031). */
function parseTodo(row: LiveEntityRow): Todo {
	const data = decodeTodoData(asRecord(row.data));
	return {
		id: row.id,
		kind: "todo",
		title: asString(data.title) ?? "Untitled",
		note: asString(data.note),
		status: asTodoStatus(data.status),
		projectId: asString(data.project_id),
		deferAt: asString(data.defer_at),
		dueAt: asString(data.due_at),
		completedAt: asString(data.completed_at),
		droppedAt: asString(data.dropped_at),
		recurrence: asRecurrence(data.recurrence),
		personRefs: (row.person_refs ?? []).map((ref) => ({
			personId: ref.person_id,
			role: ref.role,
		})),
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Todo;
}

/** Map a live `entity/list` row to the Library `Person` view model (ADR-0031). */
function parsePerson(row: LiveEntityRow): Person {
	const data = decodePersonData(asRecord(row.data));
	const aliases = Array.isArray(data.aliases)
		? data.aliases.filter((a): a is string => typeof a === "string")
		: undefined;
	return {
		id: row.id,
		kind: "person",
		name: asString(data.name) ?? "Unnamed",
		note: asString(data.note),
		aliases: aliases && aliases.length > 0 ? aliases : undefined,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Person;
}

function parseProject(row: LiveEntityRow): Project {
	const data = decodeProjectData(asRecord(row.data));
	// Carry the complete stored object verbatim so the editor can build a
	// full-document-replace `update_project` without dropping server-managed
	// fields the projection above omits (slice-7). This reads `row.data` directly,
	// NOT the decoded fields — the decode strips unknown keys, but the verbatim
	// passthrough must keep them (e.g. a legacy `review_every: "P1W"` the schema
	// can't model) so update_project's full-replace round-trips. `asRecord` shares
	// the same null/array/non-object guard as the decode above.
	const rawData = { ...asRecord(row.data) };
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
 * Map a live `entity/list` row to the Library `Bookmark` view model (ADR-0036).
 * Every field is defensively defaulted so a sparse `data` cannot crash the
 * inspector — the trap the old non-optional `recipe.ingredients` array masked.
 */
function parseBookmark(row: LiveEntityRow): Bookmark {
	const data = decodeBookmarkData(asRecord(row.data));
	const tags = Array.isArray(data.tags)
		? data.tags.filter((t): t is string => typeof t === "string")
		: undefined;
	return {
		id: row.id,
		kind: "bookmark",
		title: asString(data.title) ?? "Untitled",
		url: asString(data.url),
		note: asString(data.note),
		tags: tags && tags.length > 0 ? tags : undefined,
		source: parseSource(row.source),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Bookmark;
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
// BUILD direction (draft → mutation payload). The codec OWNS the todo draft↔wire
// mapping — "one place" for the wire shape. The TODO build is the hardest kind:
// create OMITS empty optionals (Core rejects explicit-null on create), while
// update is a HAND-BUILT DIFF whose sentinel-null clears (note/due_at/recurrence/
// completed_at = null) are a VALIDATOR-ONLY extension the advertised update_todo
// schema rejects — so this path must NOT be routed through S.encode/S.decode.
// ---------------------------------------------------------------------------

/** The editable shape of a Todo's scalar fields; `""` means absent/cleared. */
export interface TodoDraft {
	title: string;
	note: string;
	status: TodoStatus;
	projectId: string;
	dueDay: string;
	deferDay: string;
	/**
	 * The Todo's full Person-Reference set (ADR-0031/0032) — any mix of
	 * `waiting_on`/`related`, at most once per Person. The editor edits this set
	 * directly; the build emits `person_refs` (create) / `set_person_refs` (update).
	 */
	personRefs: { personId: string; role: TodoPersonRole }[];
	/** The "Repeats" toggle (ADR-0037). The fields below drive only when on. */
	recurs: boolean;
	/** Interval as text, like `dueDay` — coerced to a number on build. */
	recurInterval: string;
	recurUnit: RecurrenceUnit;
	recurAnchor: RecurAnchor;
	/**
	 * The recurrence END condition (ADR-0037/0039 amendment, #227), surfaced as a
	 * single mutually-exclusive choice — Core enforces at-most-one of until /
	 * after_count. `"never"` → no `end`; `"until"` drives `recurUntilDay`;
	 * `"after"` drives `recurAfterCount`.
	 */
	recurEnd: "never" | "until" | "after";
	/** The `until` bound as a `YYYY-MM-DD` UI date (day granularity, like `dueDay`). */
	recurUntilDay: string;
	/**
	 * The full stored `until` wall-clock string the loaded rule carried (e.g. an
	 * agent-authored `2026-12-31T23:59:59`), or `""` for a fresh draft. The editor
	 * only edits the DAY, so when `recurUntilDay` still matches this value's day
	 * prefix, `buildRecurrence` re-emits this verbatim rather than re-folding to
	 * midnight — preserving a non-midnight bound through an unrelated edit (#227
	 * review-fix; mirrors master's verbatim `end` round-trip). Only when the user
	 * changes the day does it fold to `<day>T00:00:00`.
	 */
	recurUntilStored: string;
	/** The `after_count` as text, like `recurInterval` — coerced to a number on build. */
	recurAfterCount: string;
}

/** A `YYYY-MM-DD` UI date → the `YYYY-MM-DDTHH:MM:SS` wall-clock string Core wants. */
function dayToLocal(day: string): string {
	return `${day}T00:00:00`;
}

/**
 * Read a loaded rule's `end` condition into the three flat draft fields
 * (ADR-0037/0039 amendment, #227). `until`/`after_count` are mutually exclusive
 * (Core enforces it), so `recurEnd` picks the active branch and the unused day /
 * count field stays blank.
 */
function endFieldsFromRule(rule: Todo["recurrence"]): {
	recurEnd: TodoDraft["recurEnd"];
	recurUntilDay: string;
	recurUntilStored: string;
	recurAfterCount: string;
} {
	if (rule?.end?.until !== undefined) {
		return {
			recurEnd: "until",
			recurUntilDay: rule.end.until.slice(0, 10),
			// Keep the full stored string so an unrelated edit re-emits it verbatim
			// (preserves a non-midnight bound — #227 review-fix).
			recurUntilStored: rule.end.until,
			recurAfterCount: "",
		};
	}
	if (rule?.end?.afterCount !== undefined) {
		return {
			recurEnd: "after",
			recurUntilDay: "",
			recurUntilStored: "",
			recurAfterCount: String(rule.end.afterCount),
		};
	}
	return {
		recurEnd: "never",
		recurUntilDay: "",
		recurUntilStored: "",
		recurAfterCount: "",
	};
}

/** The editable draft for a Todo (or a fresh blank draft when `todo` is absent). */
function todoDraftFromVm(todo: Todo | undefined): TodoDraft {
	const rule = todo?.recurrence;
	return {
		title: todo?.title ?? "",
		note: todo?.note ?? "",
		status: todo?.status ?? "active",
		projectId: todo?.projectId ?? "",
		dueDay: todo?.dueAt ? todo.dueAt.slice(0, 10) : "",
		deferDay: todo?.deferAt ? todo.deferAt.slice(0, 10) : "",
		// Copy the WHOLE ref set so an edit round-trips every role; the old
		// waiting_on-only read silently dropped any `related` ref on save.
		personRefs: (todo?.personRefs ?? []).map((r) => ({
			personId: r.personId,
			role: r.role,
		})),
		recurs: rule != null,
		recurInterval: rule ? String(rule.interval) : "1",
		recurUnit: rule?.unit ?? "week",
		recurAnchor: rule?.anchor ?? "defer_at",
		...endFieldsFromRule(rule),
	};
}

/**
 * True when the date the chosen anchor names is present in the draft. Core
 * rejects a recurrence whose `anchor` names a date the Todo lacks (ADR-0037), so
 * the editor only emits a rule once that date exists — the one client-knowable
 * trap, gated for good UX (Core still owns the rest of validation).
 */
function recurAnchorDatePresent(
	d: Pick<TodoDraft, "recurAnchor" | "dueDay" | "deferDay">,
): boolean {
	return d.recurAnchor === "due_at" ? d.dueDay !== "" : d.deferDay !== "";
}

/** A recurrence is emittable only when toggled on AND its anchor date exists. */
function recurActive(d: TodoDraft): boolean {
	return d.recurs && recurAnchorDatePresent(d);
}

/**
 * Whether the chosen END condition carries a usable value: `never` is always
 * complete (no value needed), `until` needs a date, `after` needs a positive
 * integer count. The single predicate behind both the editor's Save-block and the
 * preview gate, so the two can't disagree (a half-entered end must neither save
 * nor preview an unbounded rule — #227 review-fix).
 */
function recurEndComplete(d: TodoDraft): boolean {
	if (d.recurEnd === "until") return d.recurUntilDay !== "";
	if (d.recurEnd === "after") {
		const count = Number(d.recurAfterCount);
		return Number.isInteger(count) && count >= 1;
	}
	return true;
}

/** A positive-integer interval, matching the editor's Save-block guard. Used to
 * keep the preview from firing on a blank/zero interval mid-entry (Core would
 * answer `ended` for `interval < 1`, misleading the user — #227 review-fix). */
function recurIntervalValid(d: TodoDraft): boolean {
	const interval = Number(d.recurInterval);
	return Number.isInteger(interval) && interval >= 1;
}

/**
 * The snake_case recurrence rule for the payload: the common path the editor
 * drives (interval/unit/anchor) plus the END condition the user chose
 * (ADR-0037/0039 amendment, #227). `recurEnd` is mutually exclusive — `"until"`
 * folds `{until}` (a freshly chosen / day-changed date at day granularity
 * `T00:00:00` like due/defer; a stored non-midnight bound re-emits verbatim when
 * the day is untouched — see `recurUntilStored`), `"after"` folds
 * `{after_count}`, `"never"` omits `end` entirely. Assumes `recurActive(d)` —
 * callers gate on it. An incomplete end (e.g. `"after"` with a non-positive
 * count) is dropped here too; the editor's Save-block guards it for UX.
 */
function buildRecurrence(d: TodoDraft): Record<string, unknown> {
	const rule: Record<string, unknown> = {
		interval: Number(d.recurInterval),
		unit: d.recurUnit,
		anchor: d.recurAnchor,
	};
	if (d.recurEnd === "until" && d.recurUntilDay) {
		// Re-emit the stored bound verbatim when the user hasn't changed the day
		// (preserves a non-midnight `until` an agent authored — #227 review-fix);
		// only fold to midnight when the day actually changed.
		const until =
			d.recurUntilStored.slice(0, 10) === d.recurUntilDay
				? d.recurUntilStored
				: dayToLocal(d.recurUntilDay);
		rule.end = { until };
	} else if (d.recurEnd === "after") {
		const count = Number(d.recurAfterCount);
		if (Number.isInteger(count) && count >= 1)
			rule.end = { after_count: count };
	}
	return rule;
}

/** Map the draft's full ref set to the snake_case wire shape Core wants. */
function wirePersonRefs(
	refs: TodoDraft["personRefs"],
): Array<{ person_id: string; role: TodoPersonRole }> {
	return refs.map((r) => ({ person_id: r.personId, role: r.role }));
}

/**
 * The `recurrence/preview` params for a draft (ADR-0039 amendment, #227), or
 * `null` when there's nothing to preview — Repeats off, the anchor date absent,
 * End = "never" (an unbounded series has no meaningful "when does it stop"
 * preview), or an INCOMPLETE end (a blank until date / non-positive count). The
 * incomplete-end guard matters: without it the gate would enable a preview while
 * `buildRecurrence` silently drops the unusable end, so Core would compute a
 * *continuing* successor and the block would show "next occurrence" dates that
 * contradict the bounded end the user is mid-entering (#227 review-fix). The
 * editor's hook gates its read on a non-null result. Reuses `buildRecurrence` so
 * the previewed rule is byte-identical to what a save emits; the current anchor
 * dates ride alongside (day granularity, like the build path).
 */
function buildRecurrencePreviewParams(d: TodoDraft): {
	recurrence: Record<string, unknown>;
	defer_at?: string;
	due_at?: string;
} | null {
	if (
		!recurActive(d) ||
		!recurIntervalValid(d) ||
		d.recurEnd === "never" ||
		!recurEndComplete(d)
	)
		return null;
	const params: {
		recurrence: Record<string, unknown>;
		defer_at?: string;
		due_at?: string;
	} = { recurrence: buildRecurrence(d) };
	if (d.deferDay) params.defer_at = dayToLocal(d.deferDay);
	if (d.dueDay) params.due_at = dayToLocal(d.dueDay);
	return params;
}

/**
 * Build the `create_todo` payload from a draft, OMITTING empty optionals (Core
 * rejects explicit-null on create — ADR-0031/slice-3). `person_refs` is included
 * only when at least one Person is linked.
 */
function buildCreateParams(d: TodoDraft): EntityMutateParams {
	const todo: Record<string, unknown> = { title: d.title.trim() };
	if (d.note.trim()) todo.note = d.note.trim();
	if (d.status !== "active") {
		todo.status = d.status;
		todo[d.status === "completed" ? "completed_at" : "dropped_at"] =
			localNowString();
	}
	if (d.projectId) todo.project_id = d.projectId;
	if (d.dueDay) todo.due_at = dayToLocal(d.dueDay);
	if (d.deferDay) todo.defer_at = dayToLocal(d.deferDay);
	if (recurActive(d)) todo.recurrence = buildRecurrence(d);

	const payload: Record<string, unknown> = { todo };
	if (d.personRefs.length > 0)
		payload.person_refs = wirePersonRefs(d.personRefs);
	return { mutation_kind: "create_todo", payload };
}

/**
 * Canonical form of a ref set for an order-insensitive "changed?" compare: map to
 * the wire shape, sort by `person_id` then `role`, and stringify. Two sets are
 * equal iff their canon strings match, regardless of row order.
 */
function canonPersonRefs(refs: TodoDraft["personRefs"]): string {
	return JSON.stringify(
		wirePersonRefs(refs).sort(
			(a, b) =>
				a.person_id.localeCompare(b.person_id) || a.role.localeCompare(b.role),
		),
	);
}

/**
 * Build the `update_todo` payload as the DIFF of `next` against `prev`: only
 * changed scalar fields in the `todo` partial (a cleared optional sends `null`),
 * and `set_person_refs` only when the desired ref set changed. The person diff is
 * a wholesale, order-insensitive full-set REPLACE — `set_person_refs` carries the
 * complete next set (Core delete-all+inserts it, and `[]` clears all). Returns
 * `null` when nothing changed so the caller can skip the write.
 *
 * HAND-BUILT, not schema-encoded: the sentinel-null clears are a validator-only
 * extension the advertised update_todo schema rejects (constraint #1).
 */
function buildUpdateParams(
	todo: Todo,
	prev: TodoDraft,
	next: TodoDraft,
): EntityMutateParams | null {
	const partial: Record<string, unknown> = {};
	// Trim BOTH sides: the draft seeds title/note untrimmed from the stored Todo
	// (todoDraftFromVm), so a trimmed-vs-untrimmed compare would emit a spurious
	// title/note on an edit that never touched them — e.g. a quick-defer of a Todo
	// whose stored title carries surrounding whitespace (silent re-title + note clear).
	// (The Person/Project/Bookmark builders below carry the same untrimmed-prev
	// compare, but they full-REPLACE rather than partial-merge, so a false diff only
	// re-sends the already-correct value — harmless. Trimmed here only where it bites.)
	if (next.title.trim() !== prev.title.trim())
		partial.title = next.title.trim();
	if (next.note.trim() !== prev.note.trim())
		partial.note = next.note.trim() || null;
	if (next.projectId !== prev.projectId)
		partial.project_id = next.projectId || null;
	if (next.dueDay !== prev.dueDay)
		partial.due_at = next.dueDay ? dayToLocal(next.dueDay) : null;
	if (next.deferDay !== prev.deferDay)
		partial.defer_at = next.deferDay ? dayToLocal(next.deferDay) : null;
	if (next.status !== prev.status) {
		// Clear the now-invalid timestamp(s) via sentinel-null so Core's
		// re-validation of the MERGED whole doesn't trip on a stale one (ADR-0033).
		partial.status = next.status;
		if (next.status === "completed") {
			partial.completed_at = localNowString();
			partial.dropped_at = null;
		} else if (next.status === "dropped") {
			partial.dropped_at = localNowString();
			partial.completed_at = null;
		} else {
			partial.completed_at = null;
			partial.dropped_at = null;
		}
	}

	// Recurrence diffs as a whole rule: the new object when on, sentinel-null when
	// toggled off, and NO key when unchanged (matches the scalar-diff stance).
	const prevRule = recurActive(prev) ? buildRecurrence(prev) : null;
	const nextRule = recurActive(next) ? buildRecurrence(next) : null;
	if (JSON.stringify(prevRule) !== JSON.stringify(nextRule)) {
		partial.recurrence = nextRule;
	}

	const payload: Record<string, unknown> = { todo_id: todo.id };
	if (Object.keys(partial).length > 0) payload.todo = partial;

	// Person refs diff as a SET, order-insensitively. When the desired set differs
	// from the stored one, emit `set_person_refs` with the COMPLETE next set —
	// Core's set_person_refs is a wholesale delete-all+insert replace, and `[]`
	// clears all (ADR-0033). No add/remove ops: the full set is the directive.
	if (canonPersonRefs(prev.personRefs) !== canonPersonRefs(next.personRefs)) {
		payload.set_person_refs = wirePersonRefs(next.personRefs);
	}

	const touched = "todo" in payload || "set_person_refs" in payload;
	return touched ? { mutation_kind: "update_todo", payload } : null;
}

/**
 * The single TODO build entry the editor calls: dispatches on `mode`. Create
 * returns the params; update returns the diff params or `null` (no-op).
 */
function buildTodo(
	input:
		| { mode: "create"; draft: TodoDraft }
		| { mode: "update"; existing: Todo; baseline: TodoDraft; draft: TodoDraft },
): EntityMutateParams | null {
	return input.mode === "create"
		? buildCreateParams(input.draft)
		: buildUpdateParams(input.existing, input.baseline, input.draft);
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
	const payload: Record<string, unknown> = { name: d.name.trim() };
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

	const payload: Record<string, unknown> = {
		entity_id: person.id,
		name: next.name.trim(),
	};
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
// BOOKMARK build (full-document replace) — uses the promoted/ungated schema
// (slice 1). Same full-replace shape as person: title always (the validator
// requires it), url/note/tags when non-empty, cleared optional OMITTED (omit ≡
// null under replace — never sentinel-null, so the built payload conforms to
// `createBookmark`/`updateBookmark`). Returns null when nothing changed.
// ---------------------------------------------------------------------------

/** The editable shape of a Bookmark's scalar fields; `""` means absent/cleared. */
export interface BookmarkDraft {
	title: string;
	url: string;
	note: string;
	/** Tags as a comma-separated string; split on save (ADR-0036). */
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

/** The editable draft for a Bookmark (or a fresh blank draft when absent). */
function bookmarkDraftFromVm(bookmark: Bookmark | undefined): BookmarkDraft {
	return {
		title: bookmark?.title ?? "",
		url: bookmark?.url ?? "",
		note: bookmark?.note ?? "",
		tags: bookmark?.tags?.join(", ") ?? "",
	};
}

function buildBookmarkCreate(d: BookmarkDraft): EntityMutateParams {
	const payload: Record<string, unknown> = { title: d.title.trim() };
	if (d.url.trim()) payload.url = d.url.trim();
	if (d.note.trim()) payload.note = d.note.trim();
	const tags = parseTags(d.tags);
	if (tags.length > 0) payload.tags = tags;
	return { mutation_kind: "create_bookmark", payload };
}

function buildBookmarkUpdate(
	bookmark: Bookmark,
	prev: BookmarkDraft,
	next: BookmarkDraft,
): EntityMutateParams | null {
	const changed =
		next.title.trim() !== prev.title ||
		next.url.trim() !== prev.url ||
		next.note.trim() !== prev.note ||
		next.tags.trim() !== prev.tags;
	if (!changed) return null;

	const payload: Record<string, unknown> = {
		entity_id: bookmark.id,
		title: next.title.trim(),
	};
	const url = next.url.trim();
	if (url) payload.url = url;
	const note = next.note.trim();
	if (note) payload.note = note;
	const tags = parseTags(next.tags);
	if (tags.length > 0) payload.tags = tags;
	return { mutation_kind: "update_bookmark", payload };
}

/** The single BOOKMARK build entry the editor calls: dispatches on `mode`. */
function buildBookmark(
	input:
		| { mode: "create"; draft: BookmarkDraft }
		| {
				mode: "update";
				existing: Bookmark;
				baseline: BookmarkDraft;
				draft: BookmarkDraft;
		  },
): EntityMutateParams | null {
	return input.mode === "create"
		? buildBookmarkCreate(input.draft)
		: buildBookmarkUpdate(input.existing, input.baseline, input.draft);
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
	const payload: Record<string, unknown> = { name: d.name.trim() };
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
	const doc: Record<string, unknown> = { ...(project.data ?? {}) };
	delete doc.entity_id;

	doc.name = next.name.trim();
	doc.outcome = next.outcome.trim() || undefined;
	doc.note = next.note.trim() || undefined;
	doc.status = next.status;
	// Only (re)stamp the terminal timestamp(s) on a status CHANGE. When status is
	// unchanged, leave the stored `completed_at`/`dropped_at` (cloned from
	// `project.data`) intact — re-stamping every edit would silently overwrite the
	// original completion/drop date (ADR-0033).
	if (next.status !== prev.status) {
		if (next.status === "completed") {
			doc.completed_at = localNowString();
			doc.dropped_at = undefined;
		} else if (next.status === "dropped") {
			doc.dropped_at = localNowString();
			doc.completed_at = undefined;
		} else {
			doc.completed_at = undefined;
			doc.dropped_at = undefined;
		}
	}

	// Drop cleared optionals: under full-replace, an absent key carries no value
	// (omit ≡ null — ADR-0033).
	const payload: Record<string, unknown> = { entity_id: project.id };
	for (const [key, value] of Object.entries(doc)) {
		if (value !== undefined && value !== null) payload[key] = value;
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
export type ReferenceableKind = "person" | "project" | "todo";
export const REFERENCEABLE_KINDS: ReferenceableKind[] = [
	"person",
	"project",
	"todo",
];

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
	const payload: Record<string, unknown> = {
		occurred_at: localToWallClock(d.occurredAt),
		body: buildBody(d.body),
	};
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
	const payload: Record<string, unknown> = {
		entity_id: entry.id,
		occurred_at: emitWallClock(d.occurredAt, entry.occurredAt),
		body: buildBody(d.body),
	};
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
function stagedNewChip(body: DraftBodyNode[]): DraftEntityRefNode | undefined {
	return body.find(
		(node): node is DraftEntityRefNode =>
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
	chip: DraftEntityRefNode,
): EntityMutateParams {
	const payload: Record<string, unknown> = {
		source_entity_id: entry.id,
		target_entity_id: chip.newTargetId,
		body: buildReferenceBody(d.body),
	};
	if (chip.label) payload.label_snapshot = chip.label;
	return {
		mutation_kind: "reference_existing_entity_from_journal_entry",
		payload,
	};
}

export {
	bookmarkDraftFromVm,
	buildBody,
	buildBookmark,
	buildJournalEntry,
	buildJournalReference,
	buildPerson,
	buildProject,
	buildRecurrencePreviewParams,
	buildTodo,
	journalDraftFromVm,
	journalScalarsDiffer,
	parseBookmark,
	parseJournalEntry,
	parsePerson,
	parseProject,
	parseTodo,
	personDraftFromVm,
	projectDraftFromVm,
	recurAnchorDatePresent,
	stagedNewChip,
	todoDraftFromVm,
};
