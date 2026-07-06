import { useId } from "react";
import { buildProject, projectDraftFromVm } from "@/lib/entityCodec.js";
import { PROJECT_STATUS_OPTIONS, type ProjectStatus } from "@/lib/entityFields";
import { useEntityDraftEditor } from "@/lib/hooks/useEntityDraftEditor";
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
	const { draft, set, submit, saving, error } = useEntityDraftEditor({
		existing,
		draftFromVm: projectDraftFromVm,
		build: buildProject,
		onDone,
		fallbackId: (d) => d.name,
	});

	const ids = {
		name: useId(),
		outcome: useId(),
		note: useId(),
		status: useId(),
	};

	const nameEmpty = draft.name.trim() === "";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Project" : "New Project"}
			onSubmit={() => {
				if (!nameEmpty) submit();
			}}
			onCancel={onCancel}
			saving={saving}
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
