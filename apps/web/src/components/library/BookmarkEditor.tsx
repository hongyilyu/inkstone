import { useId, useState } from "react";
import {
	type BookmarkDraft,
	bookmarkDraftFromVm,
	buildBookmark,
} from "@/lib/entityCodec.js";
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

/** Create / edit a Bookmark inline in the Library rail (ADR-0036). */
export function BookmarkEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.bookmark : undefined;
	const baseline = bookmarkDraftFromVm(existing);
	const [draft, setDraft] = useState<BookmarkDraft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		title: useId(),
		url: useId(),
		tags: useId(),
		note: useId(),
	};

	const set = <K extends keyof BookmarkDraft>(
		key: K,
		value: BookmarkDraft[K],
	) => setDraft((d) => ({ ...d, [key]: value }));

	const titleEmpty = draft.title.trim() === "";

	const submit = () => {
		if (titleEmpty) return;
		const params = existing
			? buildBookmark({
					mode: "update",
					existing,
					baseline,
					draft,
				})
			: buildBookmark({ mode: "create", draft });
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
			canSave={!titleEmpty}
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
