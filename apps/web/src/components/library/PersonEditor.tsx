import type { EntityMutateParams } from "@inkstone/protocol";
import { useId, useState } from "react";
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

/** The editable shape of a Person's scalar fields; `""` means absent/cleared. */
interface Draft {
	name: string;
	note: string;
	/** Aliases as a comma-separated string; split on save (ADR-0031). */
	aliases: string;
}

/** Parse the comma-separated aliases field into a deduped, trimmed `string[]`. */
function parseAliases(raw: string): string[] {
	return raw
		.split(",")
		.map((a) => a.trim())
		.filter((a) => a.length > 0);
}

function draftFromPerson(person: Person | undefined): Draft {
	return {
		name: person?.name ?? "",
		note: person?.note ?? "",
		aliases: person?.aliases?.join(", ") ?? "",
	};
}

/**
 * Build the `create_person` payload from a draft, OMITTING empty optionals (Core
 * rejects explicit-null on create — ADR-0031/slice-3).
 */
function buildCreateParams(d: Draft): EntityMutateParams {
	const payload: Record<string, unknown> = { name: d.name.trim() };
	if (d.note.trim()) payload.note = d.note.trim();
	const aliases = parseAliases(d.aliases);
	if (aliases.length > 0) payload.aliases = aliases;
	return { mutation_kind: "create_person", payload };
}

/**
 * Build the `update_person` payload as a COMPLETE document: Core's update is a
 * full-document REPLACE, not a merge (slice-7), so an edit to one field must
 * replay every other current field or it would be WIPED. The Person view model
 * already carries all fields, so the `next` draft IS the full current+edited
 * state; we send `name` (always — the validator requires it) plus any non-empty
 * `note`/`aliases`. A cleared optional is simply absent (omit ≡ null under
 * replace — ADR-0033). Returns `null` when nothing changed so the caller skips
 * the write.
 */
function buildUpdateParams(
	person: Person,
	prev: Draft,
	next: Draft,
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

/** Create / edit a Person inline in the Library rail (ADR-0033). */
export function PersonEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.person : undefined;
	const baseline = draftFromPerson(existing);
	const [draft, setDraft] = useState<Draft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		name: useId(),
		note: useId(),
		aliases: useId(),
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
