import type { EntityMutateParams } from "@inkstone/protocol";
import {
	type Bookmark,
	type EntitySource,
	type JournalEntry,
	type JournalEntryBodyNode,
	localNowString,
	type Person,
	type Project,
	type ProjectStatus,
	type RecurrenceRule,
	type RecurrenceUnit,
	type Todo,
	type TodoStatus,
	type Weekday,
} from "@/lib/libraryItems";

// The per-Entity-Type wire codec. THIS module owns each kind's row-input shape
// and the PARSE direction (row → view-model). The `build` direction (draft →
// mutation payload) lands in later slices. Behavior here is byte-for-behavior
// identical to the `toLibrary*` parsers that still live in
// `hooks/useLibraryItems.ts` (they migrate onto this codec in a later slice).

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

/**
 * Map the flat wire provenance (ADR-0030) to the view-model `EntitySource`
 * union. Reads `journal_entry_id` first, else the Thread fields — the same
 * precedence Core's exactly-one-kind row guarantees. Returns undefined for a
 * user-authored Entity (no source) or a malformed/empty source, so a thin row
 * can never crash the inspector.
 */
function parseSource(
	source: LiveEntitySource | undefined,
): EntitySource | undefined {
	if (!source) return undefined;
	if (typeof source.journal_entry_id === "string") {
		return { kind: "journal_entry", journalEntryId: source.journal_entry_id };
	}
	if (typeof source.thread_id === "string") {
		return {
			kind: "thread",
			threadId: source.thread_id,
			threadTitle:
				typeof source.thread_title === "string" ? source.thread_title : "",
		};
	}
	return undefined;
}

interface JournalEntryData {
	occurred_at?: unknown;
	ended_at?: unknown;
	body?: unknown;
}

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function parseJournalEntry(row: LiveEntityRow): JournalEntry {
	const data = (row.data ?? {}) as JournalEntryData;
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

/** The Todo `data` shape Core stores (ADR-0031): GTD `status` + date fields. */
interface TodoData {
	title?: unknown;
	note?: unknown;
	status?: unknown;
	project_id?: unknown;
	defer_at?: unknown;
	due_at?: unknown;
	completed_at?: unknown;
	dropped_at?: unknown;
	recurrence?: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asTodoStatus(value: unknown): TodoStatus {
	return value === "completed" || value === "dropped" ? value : "active";
}

const RECURRENCE_UNITS: readonly RecurrenceUnit[] = [
	"minute",
	"hour",
	"day",
	"week",
	"month",
	"year",
];

const WEEKDAYS: readonly Weekday[] = [
	"sun",
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
];

/**
 * Defensively map a stored snake_case recurrence rule (ADR-0037) to the
 * camelCase view model. Core validates the rule on the way in, so this is
 * parsing not validation: it returns undefined unless the required fields are
 * present and well-typed, and never throws on a partial/missing shape.
 */
function asRecurrence(value: unknown): RecurrenceRule | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as Record<string, unknown>;
	if (
		typeof r.interval !== "number" ||
		typeof r.unit !== "string" ||
		!RECURRENCE_UNITS.includes(r.unit as RecurrenceUnit) ||
		(r.schedule !== "regular" && r.schedule !== "from_completion") ||
		(r.anchor !== "defer_at" && r.anchor !== "due_at")
	) {
		return undefined;
	}
	const rule: RecurrenceRule = {
		interval: r.interval,
		unit: r.unit as RecurrenceUnit,
		schedule: r.schedule,
		anchor: r.anchor,
	};
	if (typeof r.catch_up === "boolean") rule.catchUp = r.catch_up;
	if (r.only_on && typeof r.only_on === "object") {
		const onlyOnRaw = r.only_on as Record<string, unknown>;
		const onlyOn: { weekdays?: Weekday[]; monthDays?: number[] } = {};
		if (Array.isArray(onlyOnRaw.weekdays)) {
			onlyOn.weekdays = onlyOnRaw.weekdays.filter(
				(w): w is Weekday =>
					typeof w === "string" && WEEKDAYS.includes(w as Weekday),
			);
		}
		if (Array.isArray(onlyOnRaw.month_days)) {
			onlyOn.monthDays = onlyOnRaw.month_days.filter(
				(d): d is number =>
					typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31,
			);
		}
		if (onlyOn.weekdays || onlyOn.monthDays) rule.onlyOn = onlyOn;
	}
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
	const data = (row.data ?? {}) as TodoData;
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

/** The Person `data` shape Core stores (ADR-0031): `{name, note?, aliases?}`. */
interface PersonData {
	name?: unknown;
	note?: unknown;
	aliases?: unknown;
}

/** Map a live `entity/list` row to the Library `Person` view model (ADR-0031). */
function parsePerson(row: LiveEntityRow): Person {
	const data = (row.data ?? {}) as PersonData;
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

/** The Project `data` shape Core stores (ADR-0031): GTD `status` + review metadata. */
interface ProjectData {
	name?: unknown;
	status?: unknown;
	outcome?: unknown;
	note?: unknown;
	next_review_at?: unknown;
	last_reviewed_at?: unknown;
}

function asProjectStatus(value: unknown): ProjectStatus {
	return value === "on_hold" || value === "completed" || value === "dropped"
		? value
		: "active";
}

function parseProject(row: LiveEntityRow): Project {
	const data = (row.data ?? {}) as ProjectData;
	// Carry the complete stored object verbatim so the editor can build a
	// full-document-replace `update_project` without dropping server-managed
	// fields the projection above omits (slice-7).
	const rawData =
		row.data && typeof row.data === "object"
			? { ...(row.data as Record<string, unknown>) }
			: {};
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

/** The Bookmark `data` shape Core stores (ADR-0036): required `title`, optional `url`/`note`/`tags`. */
interface BookmarkData {
	title?: unknown;
	url?: unknown;
	note?: unknown;
	tags?: unknown;
}

/**
 * Map a live `entity/list` row to the Library `Bookmark` view model (ADR-0036).
 * Every field is defensively defaulted so a sparse `data` cannot crash the
 * inspector — the trap the old non-optional `recipe.ingredients` array masked.
 */
function parseBookmark(row: LiveEntityRow): Bookmark {
	const data = (row.data ?? {}) as BookmarkData;
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

// ---------------------------------------------------------------------------
// BUILD direction (draft → mutation payload). The codec OWNS the todo draft↔wire
// mapping — "one place" for the wire shape. The TODO build is the hardest kind:
// create OMITS empty optionals (Core rejects explicit-null on create), while
// update is a HAND-BUILT DIFF whose sentinel-null clears (note/due_at/recurrence/
// completed_at = null) are a VALIDATOR-ONLY extension the advertised update_todo
// schema rejects — so this path must NOT be routed through S.encode/S.decode.
// ---------------------------------------------------------------------------

type RecurSchedule = "regular" | "from_completion";
type RecurAnchor = "defer_at" | "due_at";

/** The editable shape of a Todo's scalar fields; `""` means absent/cleared. */
export interface TodoDraft {
	title: string;
	note: string;
	status: TodoStatus;
	projectId: string;
	dueDay: string;
	deferDay: string;
	/** A single `waiting_on` person link — the minimal-but-real ref op (ADR-0032). */
	waitingPersonId: string;
	/** The "Repeats" toggle (ADR-0037). The fields below drive only when on. */
	recurs: boolean;
	/** Interval as text, like `dueDay` — coerced to a number on build. */
	recurInterval: string;
	recurUnit: RecurrenceUnit;
	recurSchedule: RecurSchedule;
	recurAnchor: RecurAnchor;
	/**
	 * The loaded rule's unsurfaced fields — `catch_up`, `only_on`, `end` — stashed
	 * verbatim (re-snaked) so an edit that only touches the common path round-trips
	 * them untouched through the whole-object replace (ADR-0037 UI scope).
	 */
	recurExtra?: { catch_up?: boolean; only_on?: unknown; end?: unknown };
}

/** A `YYYY-MM-DD` UI date → the `YYYY-MM-DDTHH:MM:SS` wall-clock string Core wants. */
function dayToLocal(day: string): string {
	return `${day}T00:00:00`;
}

/**
 * Re-snake the rule's unsurfaced fields — `catchUp`/`onlyOn`/`end` — so they
 * round-trip into the emitted rule byte-for-byte. The editor never surfaces
 * these (ADR-0037), but recurrence is replaced as a whole object, so dropping
 * any of them on a common-path edit would silently lose stored state.
 */
function stashRecurExtra(
	rule: NonNullable<Todo["recurrence"]>,
): TodoDraft["recurExtra"] {
	const extra: { catch_up?: boolean; only_on?: unknown; end?: unknown } = {};
	if (rule.catchUp !== undefined) extra.catch_up = rule.catchUp;
	if (rule.onlyOn) {
		const onlyOn: Record<string, unknown> = {};
		if (rule.onlyOn.weekdays) onlyOn.weekdays = rule.onlyOn.weekdays;
		if (rule.onlyOn.monthDays) onlyOn.month_days = rule.onlyOn.monthDays;
		extra.only_on = onlyOn;
	}
	if (rule.end) {
		const end: Record<string, unknown> = {};
		if (rule.end.until !== undefined) end.until = rule.end.until;
		if (rule.end.afterCount !== undefined)
			end.after_count = rule.end.afterCount;
		extra.end = end;
	}
	return extra.catch_up !== undefined || extra.only_on || extra.end
		? extra
		: undefined;
}

/** The editable draft for a Todo (or a fresh blank draft when `todo` is absent). */
function todoDraftFromVm(todo: Todo | undefined): TodoDraft {
	const waiting = todo?.personRefs.find((r) => r.role === "waiting_on");
	const rule = todo?.recurrence;
	return {
		title: todo?.title ?? "",
		note: todo?.note ?? "",
		status: todo?.status ?? "active",
		projectId: todo?.projectId ?? "",
		dueDay: todo?.dueAt ? todo.dueAt.slice(0, 10) : "",
		deferDay: todo?.deferAt ? todo.deferAt.slice(0, 10) : "",
		waitingPersonId: waiting?.personId ?? "",
		recurs: rule != null,
		recurInterval: rule ? String(rule.interval) : "1",
		recurUnit: rule?.unit ?? "week",
		recurSchedule: rule?.schedule ?? "regular",
		recurAnchor: rule?.anchor ?? "defer_at",
		recurExtra: rule ? stashRecurExtra(rule) : undefined,
	};
}

/**
 * True when the date the chosen anchor names is present in the draft. Core
 * rejects a recurrence whose `anchor` names a date the Todo lacks (ADR-0037), so
 * the editor only emits a rule once that date exists — the one client-knowable
 * trap, gated for good UX (Core still owns the rest of validation).
 */
function recurAnchorDatePresent(d: TodoDraft): boolean {
	return d.recurAnchor === "due_at" ? d.dueDay !== "" : d.deferDay !== "";
}

/** A recurrence is emittable only when toggled on AND its anchor date exists. */
function recurActive(d: TodoDraft): boolean {
	return d.recurs && recurAnchorDatePresent(d);
}

/**
 * The snake_case recurrence rule for the payload: the common path the editor
 * drives (interval/unit/schedule/anchor) plus the stashed `catch_up`/`only_on`/
 * `end` it round-trips untouched. Assumes `recurActive(d)` — callers gate on it.
 *
 * Reconciles the stashed fields against the CURRENT surfaced schedule/unit (the
 * user can freely change those selects): `catch_up` only survives `schedule ===
 * "regular"`, `only_on.weekdays` only `unit === "week"`, `only_on.month_days`
 * only `unit === "month"` — Core's invariants (ADR-0037). Without this, switching
 * Schedule/Unit would re-emit a now-invalid field the editor never surfaces,
 * leaving the user stuck on a Core error. `end` is independent — round-trips as is.
 */
function buildRecurrence(d: TodoDraft): Record<string, unknown> {
	const rule: Record<string, unknown> = {
		interval: Number(d.recurInterval),
		unit: d.recurUnit,
		schedule: d.recurSchedule,
		anchor: d.recurAnchor,
	};
	if (d.recurExtra?.catch_up !== undefined && d.recurSchedule === "regular")
		rule.catch_up = d.recurExtra.catch_up;
	const onlyOn = d.recurExtra?.only_on as
		| { weekdays?: unknown; month_days?: unknown }
		| undefined;
	if (onlyOn) {
		const filtered: Record<string, unknown> = {};
		if (d.recurUnit === "week" && onlyOn.weekdays !== undefined)
			filtered.weekdays = onlyOn.weekdays;
		if (d.recurUnit === "month" && onlyOn.month_days !== undefined)
			filtered.month_days = onlyOn.month_days;
		// Core rejects an empty only_on, so omit it entirely when nothing survives.
		if (Object.keys(filtered).length > 0) rule.only_on = filtered;
	}
	if (d.recurExtra?.end !== undefined) rule.end = d.recurExtra.end;
	return rule;
}

/**
 * Build the `create_todo` payload from a draft, OMITTING empty optionals (Core
 * rejects explicit-null on create — ADR-0031/slice-3). `person_refs` is included
 * only when a person is linked.
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
	if (d.waitingPersonId) {
		payload.person_refs = [
			{ person_id: d.waitingPersonId, role: "waiting_on" },
		];
	}
	return { mutation_kind: "create_todo", payload };
}

/**
 * Build the `update_todo` payload as the DIFF of `next` against `prev`: only
 * changed scalar fields in the `todo` partial (a cleared optional sends `null`),
 * and `set_person_refs` only when the waiting_on link changed. Returns `null`
 * when nothing changed so the caller can skip the write.
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
	if (next.title.trim() !== prev.title) partial.title = next.title.trim();
	if (next.note.trim() !== prev.note) partial.note = next.note.trim() || null;
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

	// Person refs are a set; rebuild from the existing refs minus the old
	// waiting_on link plus the new one, and `set_person_refs` only if it differs.
	if (next.waitingPersonId !== prev.waitingPersonId) {
		const kept = todo.personRefs
			.filter((r) => r.role !== "waiting_on")
			.map((r) => ({ person_id: r.personId, role: r.role }));
		const refs = next.waitingPersonId
			? [
					...kept,
					{ person_id: next.waitingPersonId, role: "waiting_on" as const },
				]
			: kept;
		payload.set_person_refs = refs;
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

/** Parse the comma-separated aliases field into a trimmed, non-empty `string[]`. */
function parseAliases(raw: string): string[] {
	return raw
		.split(",")
		.map((a) => a.trim())
		.filter((a) => a.length > 0);
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

/**
 * The per-Entity-Type codec. Grows monotonically across slices — `build` is
 * added per kind in later slices.
 */
export const entityCodec = {
	journal_entry: { parse: parseJournalEntry, build: buildJournalEntry },
	todo: { parse: parseTodo, build: buildTodo },
	person: { parse: parsePerson, build: buildPerson },
	project: { parse: parseProject, build: buildProject },
	bookmark: { parse: parseBookmark, build: buildBookmark },
};
