import { useId, useState } from "react";
import {
	buildPerson,
	type PersonDraft,
	personDraftFromVm,
} from "@/lib/entityCodec.js";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
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
	const baseline = personDraftFromVm(existing);
	const [draft, setDraft] = useState<PersonDraft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		name: useId(),
		note: useId(),
		aliases: useId(),
	};

	const set = <K extends keyof PersonDraft>(key: K, value: PersonDraft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const nameEmpty = draft.name.trim() === "";

	const submit = () => {
		if (nameEmpty) return;
		const params = existing
			? buildPerson({
					mode: "update",
					existing,
					baseline,
					draft,
				})
			: buildPerson({ mode: "create", draft });
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
			title={existing ? "Edit Person" : "New Person"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
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
