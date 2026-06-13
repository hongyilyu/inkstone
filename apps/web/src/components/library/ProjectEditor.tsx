import type { EntityMutateParams } from "@inkstone/protocol";
import { useId, useState } from "react";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	localNowString,
	type Project,
	type ProjectStatus,
} from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

type Props = (
	| { mode: "create"; project?: undefined }
	| { mode: "edit"; project: Project }
) & {
	/** Called with the affected Project id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "on_hold", label: "On hold" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
];

/**
 * The editable shape of a Project's scalar fields; `""` means absent/cleared.
 * (`due_at`/`defer_at` and the review ritual aren't editable in this form, but
 * the update replays them verbatim from the stored data — ADR-0031.)
 */
interface Draft {
	name: string;
	outcome: string;
	note: string;
	status: ProjectStatus;
}

function draftFromProject(project: Project | undefined): Draft {
	return {
		name: project?.name ?? "",
		outcome: project?.outcome ?? "",
		note: project?.note ?? "",
		status: project?.status ?? "active",
	};
}

/**
 * Build the `create_project` payload from a draft, OMITTING empty optionals (Core
 * rejects explicit-null on create — ADR-0031/slice-3). `review_every` is never
 * sent: Core injects the default review ritual for active projects.
 */
function buildCreateParams(d: Draft): EntityMutateParams {
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

/**
 * Build the `update_project` payload as a COMPLETE document: Core's update is a
 * full-document REPLACE, not a merge (slice-7), so we replay every stored field —
 * including server-managed ones the form never renders (`review_every`, `due_at`,
 * `defer_at`, …) — with the user's edits overlaid. We start from the verbatim
 * stored `project.data` so nothing is silently dropped, then apply the form
 * fields and, on a status change, set/clear the now-(in)valid `completed_at`/
 * `dropped_at` (ADR-0033). A cleared optional is simply absent in the replaced
 * document (omit ≡ null under replace). Returns `null` when nothing changed.
 */
function buildUpdateParams(
	project: Project,
	prev: Draft,
	next: Draft,
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

/** Create / edit a Project inline in the Library rail (ADR-0033). */
export function ProjectEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.project : undefined;
	const baseline = draftFromProject(existing);
	const [draft, setDraft] = useState<Draft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		name: useId(),
		outcome: useId(),
		note: useId(),
		status: useId(),
	};

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const nameEmpty = draft.name.trim() === "";

	const submit = () => {
		if (nameEmpty) return;
		const params = existing
			? buildUpdateParams(existing, baseline, draft)
			: buildCreateParams(draft);
		if (params === null) {
			// Nothing changed — close without a write.
			onDone(existing?.id ?? draft.name);
			return;
		}
		mutation.mutate(params, {
			onSuccess: (result) =>
				onDone(result.entity_id ?? existing?.id ?? draft.name),
		});
	};

	const error =
		mutation.error == null
			? null
			: mutation.error instanceof Error
				? mutation.error.message
				: "Couldn't save. Try again.";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Project" : "New Project"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
		>
			<EditorField label="Name" htmlFor={ids.name}>
				<EditorInput
					id={ids.name}
					value={draft.name}
					placeholder="What's the project?"
					onChange={(e) => set("name", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Outcome" htmlFor={ids.outcome}>
				<EditorTextarea
					id={ids.outcome}
					value={draft.outcome}
					placeholder="What does done look like?"
					onChange={(e) => set("outcome", e.target.value)}
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
					onChange={(e) => set("status", e.target.value as ProjectStatus)}
				>
					{STATUS_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</EditorSelect>
			</EditorField>
		</EntityEditorFrame>
	);
}
