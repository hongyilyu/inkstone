import { useId, useState } from "react";
import {
	buildTodo,
	recurAnchorDatePresent,
	type TodoDraft,
	todoDraftFromVm,
} from "@/lib/entityCodec.js";
import {
	RECUR_ANCHOR_OPTIONS,
	RECURRENCE_UNIT_OPTIONS,
	type RecurAnchor,
	type RecurrenceUnit,
	TODO_PERSON_ROLE_OPTIONS,
	TODO_STATUS_OPTIONS,
	type TodoStatus,
} from "@/lib/entityFields";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import type {
	LibraryItem,
	Person,
	Project,
	Todo,
	TodoPersonRole,
} from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

// A monotonically increasing counter mints a STABLE React key per person row —
// the row identity must survive add/remove/reorder, so it can't be the array
// index (which would re-key surviving rows on a removal). Module-level so the
// sequence is unique across the component's lifetime.
let nextPersonRowKey = 0;

/** One editable person-reference row: a stable key plus the draftable fields. */
interface PersonRow {
	key: number;
	personId: string;
	role: TodoPersonRole;
}

/** Seed the rows from a draft's ref set (one row per stored ref), minting keys. */
function seedPersonRows(refs: TodoDraft["personRefs"]): PersonRow[] {
	return refs.map((r) => ({
		key: nextPersonRowKey++,
		personId: r.personId,
		role: r.role,
	}));
}

type Props = (
	| { mode: "create"; todo?: undefined }
	| { mode: "edit"; todo: Todo }
) & {
	allEntities: LibraryItem[];
	/** Called with the affected Todo id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/** Create / edit a Todo inline in the Library rail (ADR-0033). */
export function TodoEditor({ allEntities, onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.todo : undefined;
	const baseline = todoDraftFromVm(existing);
	const [draft, setDraft] = useState<TodoDraft>(baseline);
	// The person-reference ROWS are the UI source of truth (they hold blank,
	// not-yet-chosen rows the codec must not see); `draft.personRefs` is derived
	// from them on every mutation, filtering empty rows out. Seeded once from the
	// baseline so an existing Todo opens with one row per stored ref.
	const [personRows, setPersonRows] = useState<PersonRow[]>(() =>
		seedPersonRows(baseline.personRefs),
	);
	const mutation = useEntityMutation();

	const ids = {
		title: useId(),
		note: useId(),
		status: useId(),
		project: useId(),
		due: useId(),
		defer: useId(),
		recurs: useId(),
		recurInterval: useId(),
		recurUnit: useId(),
		recurAnchor: useId(),
	};

	const people = allEntities.filter((e): e is Person => e.kind === "person");
	const projects = allEntities.filter(
		(e): e is Project => e.kind === "project",
	);

	const set = <K extends keyof TodoDraft>(key: K, value: TodoDraft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	// Apply a rows transform and re-derive the draft's ref set from it — blank
	// (no-person) rows live only in the UI and are filtered out so the codec never
	// emits a `person_id: ""` Core would reject.
	const updatePersonRows = (next: (rows: PersonRow[]) => PersonRow[]) =>
		setPersonRows((rows) => {
			const updated = next(rows);
			set(
				"personRefs",
				updated
					.filter((r) => r.personId !== "")
					.map((r) => ({ personId: r.personId, role: r.role })),
			);
			return updated;
		});

	// A new row defaults to `related` and no person yet; the user picks the person.
	const addPersonRow = () =>
		updatePersonRows((rows) => [
			...rows,
			{ key: nextPersonRowKey++, personId: "", role: "related" },
		]);
	const updatePersonRow = (
		key: number,
		patch: Partial<Omit<PersonRow, "key">>,
	) =>
		updatePersonRows((rows) =>
			rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
		);
	const removePersonRow = (key: number) =>
		updatePersonRows((rows) => rows.filter((r) => r.key !== key));

	// Toggling Repeats on defaults the anchor to whichever date the Todo already
	// has (due preferred), so the emitted rule's anchor date is present (ADR-0037).
	const toggleRecurs = (recurs: boolean) =>
		setDraft((d) => ({
			...d,
			recurs,
			recurAnchor: recurs ? (d.dueDay ? "due_at" : "defer_at") : d.recurAnchor,
		}));

	// Single source of truth for "can't save yet, and why" (null = savable). The
	// frame derives both the disabled Save and the hint from this one value, so a
	// guard can't be added to one place and forgotten in the other. Order = priority.
	const saveBlock: string | null = (() => {
		if (draft.title.trim() === "") return "Add a title to save";
		if (draft.recurs) {
			// Interval is free text on a number input; Core requires a positive integer.
			const interval = Number(draft.recurInterval);
			if (!Number.isInteger(interval) || interval < 1)
				return "Enter a whole repeat interval of 1 or more";
			// Repeats on but the anchor's date absent: Core would reject the rule.
			if (!recurAnchorDatePresent(draft))
				return `Set the ${draft.recurAnchor === "due_at" ? "due" : "defer"} date to save this repeat`;
		}
		return null;
	})();

	const submit = () => {
		if (saveBlock !== null) return;
		const params = existing
			? buildTodo({ mode: "update", existing, baseline, draft })
			: buildTodo({ mode: "create", draft });
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
			canSave={saveBlock === null}
			disabledReason={saveBlock ?? undefined}
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
					{TODO_STATUS_OPTIONS.map((o) => (
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
						{/* The interval-invalid guidance lives in the frame's
						    `disabledReason` (by Save), so it isn't duplicated here. */}

						<EditorField label="Unit" htmlFor={ids.recurUnit}>
							<EditorSelect
								id={ids.recurUnit}
								value={draft.recurUnit}
								onChange={(e) =>
									set("recurUnit", e.target.value as RecurrenceUnit)
								}
							>
								{RECURRENCE_UNIT_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</EditorSelect>
						</EditorField>

						<EditorField label="Repeat from" htmlFor={ids.recurAnchor}>
							<EditorSelect
								id={ids.recurAnchor}
								value={draft.recurAnchor}
								onChange={(e) =>
									set("recurAnchor", e.target.value as RecurAnchor)
								}
							>
								{RECUR_ANCHOR_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</EditorSelect>
							<p className="text-muted-foreground text-xs leading-relaxed">
								Which date the next occurrence counts from.
							</p>
						</EditorField>
						{/* The anchor-missing guidance now lives in the frame's
						    `disabledReason` (by Save), so it isn't duplicated here. */}
					</>
				) : null}
			</div>

			<div className="flex flex-col gap-3">
				<span className="font-medium text-muted-foreground text-xs">
					People
				</span>
				{personRows.map((row, index) => {
					// Dedupe is structural: this row's picker offers people NOT chosen
					// in any OTHER row, so a Person can be referenced at most once. The
					// row's own current selection always stays selectable.
					const takenElsewhere = new Set(
						personRows
							.filter((r) => r.key !== row.key && r.personId !== "")
							.map((r) => r.personId),
					);
					const offered = people.filter(
						(p) => p.id === row.personId || !takenElsewhere.has(p.id),
					);
					return (
						<div key={row.key} className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<EditorSelect
									aria-label="Person"
									value={row.personId}
									onChange={(e) =>
										updatePersonRow(row.key, { personId: e.target.value })
									}
								>
									<option value="">Choose a person</option>
									{offered.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name}
										</option>
									))}
								</EditorSelect>
							</div>
							<div className="w-32 shrink-0">
								<EditorSelect
									aria-label="Role"
									value={row.role}
									onChange={(e) =>
										updatePersonRow(row.key, {
											role: e.target.value as TodoPersonRole,
										})
									}
								>
									{TODO_PERSON_ROLE_OPTIONS.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</EditorSelect>
							</div>
							<button
								type="button"
								onClick={() => removePersonRow(row.key)}
								aria-label={`Remove person row ${index + 1}`}
								className="h-10 shrink-0 rounded-lg border border-input px-3 text-muted-foreground text-sm transition-colors hover:bg-secondary/50 hover:text-foreground"
							>
								Remove
							</button>
						</div>
					);
				})}
				<button
					type="button"
					onClick={addPersonRow}
					className="self-start rounded-lg border border-input px-3.5 py-1.5 font-medium text-foreground/80 text-sm transition-colors hover:bg-secondary/50 hover:text-foreground"
				>
					Add person
				</button>
			</div>
		</EntityEditorFrame>
	);
}
