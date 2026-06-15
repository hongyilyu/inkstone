import type { EntityMutateParams } from "@inkstone/protocol";
import { useId, useState } from "react";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type LibraryItem,
	localNowString,
	type Person,
	type Project,
	type RecurrenceUnit,
	type Todo,
	type TodoStatus,
} from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

type Props = (
	| { mode: "create"; todo?: undefined }
	| { mode: "edit"; todo: Todo }
) & {
	allEntities: LibraryItem[];
	/** Called with the affected Todo id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

const STATUS_OPTIONS: { value: TodoStatus; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
];

const UNIT_OPTIONS: { value: RecurrenceUnit; label: string }[] = [
	{ value: "minute", label: "Minutes" },
	{ value: "hour", label: "Hours" },
	{ value: "day", label: "Days" },
	{ value: "week", label: "Weeks" },
	{ value: "month", label: "Months" },
	{ value: "year", label: "Years" },
];

type RecurSchedule = "regular" | "from_completion";
type RecurAnchor = "defer_at" | "due_at";

const SCHEDULE_OPTIONS: { value: RecurSchedule; label: string }[] = [
	{ value: "regular", label: "Regular" },
	{ value: "from_completion", label: "From completion" },
];

const ANCHOR_OPTIONS: { value: RecurAnchor; label: string }[] = [
	{ value: "defer_at", label: "Defer date" },
	{ value: "due_at", label: "Due date" },
];

/** The editable shape of a Todo's scalar fields; `""` means absent/cleared. */
interface Draft {
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
): Draft["recurExtra"] {
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

function draftFromTodo(todo: Todo | undefined): Draft {
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
function recurAnchorDatePresent(d: Draft): boolean {
	return d.recurAnchor === "due_at" ? d.dueDay !== "" : d.deferDay !== "";
}

/** A recurrence is emittable only when toggled on AND its anchor date exists. */
function recurActive(d: Draft): boolean {
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
function buildRecurrence(d: Draft): Record<string, unknown> {
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
function buildCreateParams(d: Draft): EntityMutateParams {
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
 */
function buildUpdateParams(
	todo: Todo,
	prev: Draft,
	next: Draft,
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

/** Create / edit a Todo inline in the Library rail (ADR-0033). */
export function TodoEditor({ allEntities, onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.todo : undefined;
	const baseline = draftFromTodo(existing);
	const [draft, setDraft] = useState<Draft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		title: useId(),
		note: useId(),
		status: useId(),
		project: useId(),
		due: useId(),
		defer: useId(),
		waiting: useId(),
		recurs: useId(),
		recurInterval: useId(),
		recurUnit: useId(),
		recurSchedule: useId(),
		recurAnchor: useId(),
	};

	const people = allEntities.filter((e): e is Person => e.kind === "person");
	const projects = allEntities.filter(
		(e): e is Project => e.kind === "project",
	);

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	// Toggling Repeats on defaults the anchor to whichever date the Todo already
	// has (due preferred), so the emitted rule's anchor date is present (ADR-0037).
	const toggleRecurs = (recurs: boolean) =>
		setDraft((d) => ({
			...d,
			recurs,
			recurAnchor: recurs ? (d.dueDay ? "due_at" : "defer_at") : d.recurAnchor,
		}));

	const titleEmpty = draft.title.trim() === "";
	// Repeats is on but the anchor's date is absent: Core would reject the rule, so
	// block Save until the date is set rather than silently dropping the rule.
	const anchorMissing = draft.recurs && !recurAnchorDatePresent(draft);
	// The interval is free text on a number input; Core requires a positive integer,
	// so block Save on empty/0/fractional/negative rather than emitting an invalid rule.
	const intervalInvalid =
		draft.recurs &&
		(!Number.isInteger(Number(draft.recurInterval)) ||
			Number(draft.recurInterval) < 1);

	const submit = () => {
		if (titleEmpty || anchorMissing || intervalInvalid) return;
		const params = existing
			? buildUpdateParams(existing, baseline, draft)
			: buildCreateParams(draft);
		if (params === null) {
			// Nothing changed — close without a write.
			onDone(existing?.id ?? draft.title);
			return;
		}
		mutation.mutate(params, {
			onSuccess: (result) =>
				onDone(result.entity_id ?? existing?.id ?? draft.title),
		});
	};

	const error =
		mutation.error == null
			? null
			: mutation.error instanceof Error && mutation.error.message
				? mutation.error.message
				: "Couldn't save. Try again.";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Todo" : "New Todo"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
		>
			<EditorField label="Title" htmlFor={ids.title}>
				<EditorInput
					id={ids.title}
					value={draft.title}
					placeholder="What needs doing?"
					onChange={(e) => set("title", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Note" htmlFor={ids.note}>
				<EditorTextarea
					id={ids.note}
					value={draft.note}
					placeholder="Optional detail"
					onChange={(e) => set("note", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Status" htmlFor={ids.status}>
				<EditorSelect
					id={ids.status}
					value={draft.status}
					onChange={(e) => set("status", e.target.value as TodoStatus)}
				>
					{STATUS_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</EditorSelect>
			</EditorField>

			<EditorField label="Project" htmlFor={ids.project}>
				<EditorSelect
					id={ids.project}
					value={draft.projectId}
					onChange={(e) => set("projectId", e.target.value)}
				>
					<option value="">No project</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</EditorSelect>
			</EditorField>

			<EditorField label="Due" htmlFor={ids.due}>
				<EditorInput
					id={ids.due}
					type="date"
					value={draft.dueDay}
					onChange={(e) => set("dueDay", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Defer until" htmlFor={ids.defer}>
				<EditorInput
					id={ids.defer}
					type="date"
					value={draft.deferDay}
					onChange={(e) => set("deferDay", e.target.value)}
				/>
			</EditorField>

			<div className="flex flex-col gap-3">
				<label
					htmlFor={ids.recurs}
					className="flex items-center gap-2 font-medium text-muted-foreground text-xs"
				>
					<input
						id={ids.recurs}
						type="checkbox"
						checked={draft.recurs}
						onChange={(e) => toggleRecurs(e.target.checked)}
					/>
					Repeats
				</label>

				{draft.recurs ? (
					<>
						<EditorField label="Every" htmlFor={ids.recurInterval}>
							<EditorInput
								id={ids.recurInterval}
								type="number"
								min={1}
								value={draft.recurInterval}
								onChange={(e) => set("recurInterval", e.target.value)}
							/>
						</EditorField>

						{intervalInvalid ? (
							<p className="text-muted-foreground text-xs leading-relaxed">
								Enter a whole number of 1 or more to save this repeat.
							</p>
						) : null}

						<EditorField label="Unit" htmlFor={ids.recurUnit}>
							<EditorSelect
								id={ids.recurUnit}
								value={draft.recurUnit}
								onChange={(e) =>
									set("recurUnit", e.target.value as RecurrenceUnit)
								}
							>
								{UNIT_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</EditorSelect>
						</EditorField>

						<EditorField label="Schedule" htmlFor={ids.recurSchedule}>
							<EditorSelect
								id={ids.recurSchedule}
								value={draft.recurSchedule}
								onChange={(e) =>
									set("recurSchedule", e.target.value as RecurSchedule)
								}
							>
								{SCHEDULE_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</EditorSelect>
						</EditorField>

						<EditorField label="Anchor" htmlFor={ids.recurAnchor}>
							<EditorSelect
								id={ids.recurAnchor}
								value={draft.recurAnchor}
								onChange={(e) =>
									set("recurAnchor", e.target.value as RecurAnchor)
								}
							>
								{ANCHOR_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</EditorSelect>
						</EditorField>

						{anchorMissing ? (
							<p className="text-muted-foreground text-xs leading-relaxed">
								Set the {draft.recurAnchor === "due_at" ? "due" : "defer"} date
								to save this repeat.
							</p>
						) : null}
					</>
				) : null}
			</div>

			<EditorField label="Waiting on" htmlFor={ids.waiting}>
				<EditorSelect
					id={ids.waiting}
					value={draft.waitingPersonId}
					onChange={(e) => set("waitingPersonId", e.target.value)}
				>
					<option value="">No one</option>
					{people.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</EditorSelect>
			</EditorField>
		</EntityEditorFrame>
	);
}
