import type { EntityMutateParams } from "@inkstone/protocol";
import { useId, useState } from "react";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import type { Bookmark } from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

type Props = (
	| { mode: "create"; bookmark?: undefined }
	| { mode: "edit"; bookmark: Bookmark }
) & {
	/** Called with the affected Bookmark id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/** The editable shape of a Bookmark's scalar fields; `""` means absent/cleared. */
interface Draft {
	title: string;
	url: string;
	note: string;
	/** Tags as a comma-separated string; split on save (ADR-0036). */
	tags: string;
}

/** Parse the comma-separated tags field into a deduped, trimmed `string[]`. */
function parseTags(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(",")
				.map((t) => t.trim())
				.filter((t) => t.length > 0),
		),
	];
}

function draftFromBookmark(bookmark: Bookmark | undefined): Draft {
	return {
		title: bookmark?.title ?? "",
		url: bookmark?.url ?? "",
		note: bookmark?.note ?? "",
		tags: bookmark?.tags?.join(", ") ?? "",
	};
}

/**
 * Build the `create_bookmark` payload from a draft, OMITTING empty optionals (Core
 * rejects explicit-null on create — ADR-0036).
 */
function buildCreateParams(d: Draft): EntityMutateParams {
	const payload: Record<string, unknown> = { title: d.title.trim() };
	if (d.url.trim()) payload.url = d.url.trim();
	if (d.note.trim()) payload.note = d.note.trim();
	const tags = parseTags(d.tags);
	if (tags.length > 0) payload.tags = tags;
	return { mutation_kind: "create_bookmark", payload };
}

/**
 * Build the `update_bookmark` payload as a COMPLETE document: Core's update is a
 * full-document REPLACE, not a merge, so an edit to one field must replay every
 * other current field or it would be WIPED. The Bookmark view model already
 * carries all fields, so the `next` draft IS the full current+edited state; we
 * send `title` (always — the validator requires it) plus any non-empty
 * `url`/`note`/`tags`. A cleared optional is simply absent (omit ≡ null under
 * replace — ADR-0036). Returns `null` when nothing changed so the caller skips
 * the write.
 */
function buildUpdateParams(
	bookmark: Bookmark,
	prev: Draft,
	next: Draft,
): EntityMutateParams | null {
	const changed =
		next.title.trim() !== prev.title ||
		next.url.trim() !== prev.url ||
		next.note.trim() !== prev.note ||
		next.tags.trim() !== prev.tags;
	if (!changed) return null;

	const payload: Record<string, unknown> = {
		entity_id: bookmark.id,
		title: next.title.trim(),
	};
	const url = next.url.trim();
	if (url) payload.url = url;
	const note = next.note.trim();
	if (note) payload.note = note;
	const tags = parseTags(next.tags);
	if (tags.length > 0) payload.tags = tags;
	return { mutation_kind: "update_bookmark", payload };
}

/** Create / edit a Bookmark inline in the Library rail (ADR-0036). */
export function BookmarkEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.bookmark : undefined;
	const baseline = draftFromBookmark(existing);
	const [draft, setDraft] = useState<Draft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		title: useId(),
		url: useId(),
		tags: useId(),
		note: useId(),
	};

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
			title={existing ? "Edit Bookmark" : "New Bookmark"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
		>
			<EditorField label="Title" htmlFor={ids.title}>
				<EditorInput
					id={ids.title}
					value={draft.title}
					placeholder="What did you save?"
					onChange={(e) => set("title", e.target.value)}
				/>
			</EditorField>

			<EditorField label="URL" htmlFor={ids.url}>
				<EditorInput
					id={ids.url}
					value={draft.url}
					placeholder="https://…"
					onChange={(e) => set("url", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Tags" htmlFor={ids.tags}>
				<EditorInput
					id={ids.tags}
					value={draft.tags}
					placeholder="Comma-separated"
					onChange={(e) => set("tags", e.target.value)}
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
