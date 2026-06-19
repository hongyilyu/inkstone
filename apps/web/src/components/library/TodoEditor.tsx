import { useId, useState } from "react";
import {
	buildTodo,
	recurAnchorDatePresent,
	type TodoDraft,
	todoDraftFromVm,
} from "@/lib/entityCodec.js";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import type {
	LibraryItem,
	Person,
	Project,
	RecurrenceUnit,
	Todo,
	TodoStatus,
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

type RecurAnchor = "defer_at" | "due_at";

const ANCHOR_OPTIONS: { value: RecurAnchor; label: string }[] = [
	{ value: "defer_at", label: "Defer date" },
	{ value: "due_at", label: "Due date" },
];

/** Create / edit a Todo inline in the Library rail (ADR-0033). */
export function TodoEditor({ allEntities, onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.todo : undefined;
	const baseline = todoDraftFromVm(existing);
	const [draft, setDraft] = useState<TodoDraft>(baseline);
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
		recurAnchor: useId(),
	};

	const people = allEntities.filter((e): e is Person => e.kind === "person");
	const projects = allEntities.filter(
		(e): e is Project => e.kind === "project",
	);

	const set = <K extends keyof TodoDraft>(key: K, value: TodoDraft[K]) =>
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
			canSave={!titleEmpty && !anchorMissing && !intervalInvalid}
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
