import type { EntityMutateParams } from "@inkstone/protocol";
import { useId, useState } from "react";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type LibraryItem,
	localNowString,
	type Person,
	type Project,
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
}

/** A `YYYY-MM-DD` UI date → the `YYYY-MM-DDTHH:MM:SS` wall-clock string Core wants. */
function dayToLocal(day: string): string {
	return `${day}T00:00:00`;
}

function draftFromTodo(todo: Todo | undefined): Draft {
	const waiting = todo?.personRefs.find((r) => r.role === "waiting_on");
	return {
		title: todo?.title ?? "",
		note: todo?.note ?? "",
		status: todo?.status ?? "active",
		projectId: todo?.projectId ?? "",
		dueDay: todo?.dueAt ? todo.dueAt.slice(0, 10) : "",
		deferDay: todo?.deferAt ? todo.deferAt.slice(0, 10) : "",
		waitingPersonId: waiting?.personId ?? "",
	};
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
	};

	const people = allEntities.filter((e): e is Person => e.kind === "person");
	const projects = allEntities.filter(
		(e): e is Project => e.kind === "project",
	);

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const titleEmpty = draft.title.trim() === "";

	const submit = () => {
		if (titleEmpty) return;
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
