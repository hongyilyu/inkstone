import { useId, useState } from "react";
import {
	buildProject,
	type ProjectDraft,
	projectDraftFromVm,
} from "@/lib/entityCodec.js";
import { PROJECT_STATUS_OPTIONS, type ProjectStatus } from "@/lib/entityFields";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import type { Project } from "@/lib/libraryItems";
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

/** Create / edit a Project inline in the Library rail (ADR-0033). */
export function ProjectEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.project : undefined;
	const baseline = projectDraftFromVm(existing);
	const [draft, setDraft] = useState<ProjectDraft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		name: useId(),
		outcome: useId(),
		note: useId(),
		status: useId(),
	};

	const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const nameEmpty = draft.name.trim() === "";

	const submit = () => {
		if (nameEmpty) return;
		const params = existing
			? buildProject({
					mode: "update",
					existing,
					baseline,
					draft,
				})
			: buildProject({ mode: "create", draft });
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
			: mutation.error instanceof Error && mutation.error.message
				? mutation.error.message
				: "Couldn't save. Try again.";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Project" : "New Project"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
			canSave={!nameEmpty}
			disabledReason="Add a name to save"
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
					{PROJECT_STATUS_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</EditorSelect>
			</EditorField>
		</EntityEditorFrame>
	);
}
