import { useId } from "react";
import { buildPerson, personDraftFromVm } from "@/lib/entityCodec.js";
import { useEntityDraftEditor } from "@/lib/hooks/useEntityDraftEditor";
import type { Person } from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

type Props = (
	| { mode: "create"; person?: undefined }
	| { mode: "edit"; person: Person }
) & {
	/** Called with the affected Person id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/** Create / edit a Person inline in the Library rail (ADR-0033). */
export function PersonEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.person : undefined;
	const { draft, set, submit, saving, error } = useEntityDraftEditor({
		existing,
		draftFromVm: personDraftFromVm,
		build: buildPerson,
		onDone,
		fallbackId: (d) => d.name,
	});

	const ids = {
		name: useId(),
		note: useId(),
		aliases: useId(),
	};

	const nameEmpty = draft.name.trim() === "";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Person" : "New Person"}
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
					placeholder="Who is this?"
					onChange={(e) => set("name", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Also known as" htmlFor={ids.aliases}>
				<EditorInput
					id={ids.aliases}
					value={draft.aliases}
					placeholder="Other names, comma-separated"
					onChange={(e) => set("aliases", e.target.value)}
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
		</EntityEditorFrame>
	);
}
