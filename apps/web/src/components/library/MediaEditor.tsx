import { useId, useState } from "react";
import {
	buildMedia,
	type MediaDraft,
	mediaDraftFromVm,
} from "@/lib/entityCodec.js";
import {
	MEDIA_MEDIUM_OPTIONS,
	MEDIA_STATE_OPTIONS,
	type MediaState,
} from "@/lib/entityFields";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import type { Media } from "@/lib/libraryItems";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
	EntityEditorFrame,
} from "./EntityEditor.js";

type Props = (
	| { mode: "create"; media?: undefined }
	| { mode: "edit"; media: Media }
) & {
	/** Called with the affected Media id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/** The states in which a finish rating/date is meaningful (ADR-0059). */
function isTerminalState(state: MediaState): boolean {
	return state === "done" || state === "abandoned";
}

/** Create / edit a Media item inline in the Library rail (ADR-0059). */
export function MediaEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.media : undefined;
	const baseline = mediaDraftFromVm(existing);
	const [draft, setDraft] = useState<MediaDraft>(baseline);
	const mutation = useEntityMutation();

	const ids = {
		title: useId(),
		medium: useId(),
		state: useId(),
		rating: useId(),
		finished: useId(),
		url: useId(),
		tags: useId(),
		note: useId(),
	};

	const set = <K extends keyof MediaDraft>(key: K, value: MediaDraft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	// When the state leaves terminal, clear rating/finished from the draft so a
	// stale value isn't carried (Core rejects them off-terminal — ADR-0059).
	const setState = (state: MediaState) =>
		setDraft((d) =>
			isTerminalState(state)
				? { ...d, state }
				: { ...d, state, rating: "", finishedDay: "" },
		);

	const titleEmpty = draft.title.trim() === "";
	const terminal = isTerminalState(draft.state);

	const submit = () => {
		if (titleEmpty) return;
		const params = existing
			? buildMedia({ mode: "update", existing, baseline, draft })
			: buildMedia({ mode: "create", draft });
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
			title={existing ? "Edit Media" : "New Media"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
			canSave={!titleEmpty}
			disabledReason="Add a title to save"
		>
			<EditorField label="Title" htmlFor={ids.title}>
				<EditorInput
					id={ids.title}
					value={draft.title}
					placeholder="What are you reading or watching?"
					onChange={(e) => set("title", e.target.value)}
				/>
			</EditorField>

			<EditorField label="Medium" htmlFor={ids.medium}>
				<EditorSelect
					id={ids.medium}
					value={draft.medium}
					onChange={(e) =>
						set("medium", e.target.value as MediaDraft["medium"])
					}
				>
					{MEDIA_MEDIUM_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</EditorSelect>
			</EditorField>

			<EditorField label="State" htmlFor={ids.state}>
				<EditorSelect
					id={ids.state}
					value={draft.state}
					onChange={(e) => setState(e.target.value as MediaState)}
				>
					{MEDIA_STATE_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</EditorSelect>
			</EditorField>

			{/* Rating + finished date only matter once consumed (ADR-0059). Off-terminal
			    they neither render nor emit — Core rejects them in a non-terminal state. */}
			{terminal ? (
				<>
					<EditorField label="Rating" htmlFor={ids.rating}>
						<EditorInput
							id={ids.rating}
							type="number"
							min={1}
							max={5}
							value={draft.rating}
							placeholder="1–5"
							onChange={(e) => set("rating", e.target.value)}
						/>
					</EditorField>

					<EditorField label="Finished" htmlFor={ids.finished}>
						<EditorInput
							id={ids.finished}
							type="date"
							value={draft.finishedDay}
							onChange={(e) => set("finishedDay", e.target.value)}
						/>
					</EditorField>
				</>
			) : null}

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
