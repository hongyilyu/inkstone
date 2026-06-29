import {
	ObservationUpdateParams,
	type ObservationUpdateParams as ObservationUpdatePayload,
} from "@inkstone/protocol";
import { Either, Schema as S } from "effect";
import { type ReactNode, useId, useMemo, useState } from "react";
import type { ObservationItemView } from "@/lib/observationView";
import { EditorField, EditorInput, EditorTextarea } from "./EntityEditor.js";

const decodeObservationUpdateParams = S.decodeUnknownEither(
	ObservationUpdateParams,
	{ onExcessProperty: "error" },
);

/** Pretty-print the row's current `values` to seed the JSON textarea. */
function prettyValues(values: unknown): string {
	return JSON.stringify(values ?? {}, null, 2) ?? "{}";
}

/** Assemble + validate the source-free full-replacement draft from the form fields.
 * Omits `ended_at`/`note` when blank (full-replace "clear the field" semantics, per
 * ADR-0033 omit-not-empty-string). NEVER assembles `schema_key` or `source` — the
 * object simply has no such keys. */
function buildDraft(fields: {
	observationId: string;
	occurredAt: string;
	endedAt: string;
	note: string;
	valuesText: string;
}):
	| { value: ObservationUpdatePayload; error: null }
	| { value: null; error: string } {
	let parsedValues: unknown;
	try {
		parsedValues = JSON.parse(fields.valuesText);
	} catch {
		return { value: null, error: "values must be valid JSON" };
	}

	const endedAt = fields.endedAt.trim();
	const note = fields.note.trim();
	const candidate = {
		observation_id: fields.observationId,
		observation: {
			occurred_at: fields.occurredAt.trim(),
			...(endedAt ? { ended_at: endedAt } : {}),
			values: parsedValues,
			...(note ? { note } : {}),
		},
	};

	const decoded = decodeObservationUpdateParams(candidate);
	if (Either.isLeft(decoded)) {
		return {
			value: null,
			error:
				"Check the fields — occurred_at/ended_at must be YYYY-MM-DDTHH:MM:SS and values a JSON object.",
		};
	}
	const { observation } = decoded.right;
	if (
		observation.ended_at !== undefined &&
		observation.ended_at < observation.occurred_at
	) {
		return {
			value: null,
			error: "ended_at must be greater than or equal to occurred_at",
		};
	}
	return { value: decoded.right, error: null };
}

/**
 * Inline correction editor for a single recorded observation (#255). Option B
 * (grilled): typed scalar inputs for `occurred_at` / `ended_at` / `note` plus one
 * pretty-printed JSON `values` textarea, all pre-filled from the row's CURRENT
 * fact fields. Submitting assembles a SOURCE-FREE full-replacement draft (no
 * `schema_key`, no `source`) and hands it to `onSubmit`. Provenance is immutable
 * and lives in the parent row, not here.
 *
 * A pure-ish component: the parent owns the mutation (`submitting`/`error`) and the
 * open/close (`onCancel`). It validates the assembled draft against
 * `ObservationUpdateParams` before enabling Save, surfacing a parse/shape error
 * inline; a Core-side `WsError` (e.g. `values` mismatching the stored schema) flows
 * back through the parent's `error` prop.
 */
export function ObservationCorrectionForm({
	item,
	submitting,
	error,
	onSubmit,
	onCancel,
}: {
	item: ObservationItemView;
	submitting: boolean;
	error: string | null;
	onSubmit: (params: ObservationUpdatePayload) => void;
	onCancel: () => void;
}): ReactNode {
	const occurredId = useId();
	const endedId = useId();
	const valuesId = useId();
	const noteId = useId();

	const [occurredAt, setOccurredAt] = useState(item.occurredAt);
	const [endedAt, setEndedAt] = useState(item.endedAt ?? "");
	const [note, setNote] = useState(item.note ?? "");
	const [valuesText, setValuesText] = useState(() => prettyValues(item.values));

	const draft = useMemo(
		() =>
			buildDraft({
				observationId: item.id,
				occurredAt,
				endedAt,
				note,
				valuesText,
			}),
		[item.id, occurredAt, endedAt, note, valuesText],
	);

	const submit = () => {
		if (submitting || draft.value === null) return;
		onSubmit(draft.value);
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			aria-label="Correct observation"
			className="mt-3 flex flex-col gap-3 border-border border-t pt-3"
		>
			<EditorField label="Occurred at" htmlFor={occurredId}>
				<EditorInput
					id={occurredId}
					value={occurredAt}
					spellCheck={false}
					onChange={(event) => setOccurredAt(event.target.value)}
				/>
			</EditorField>
			<EditorField label="Ended at (optional)" htmlFor={endedId}>
				<EditorInput
					id={endedId}
					value={endedAt}
					spellCheck={false}
					onChange={(event) => setEndedAt(event.target.value)}
				/>
			</EditorField>
			<EditorField label="Values" htmlFor={valuesId}>
				<EditorTextarea
					id={valuesId}
					value={valuesText}
					spellCheck={false}
					onChange={(event) => setValuesText(event.target.value)}
				/>
			</EditorField>
			<EditorField label="Note (optional)" htmlFor={noteId}>
				<EditorTextarea
					id={noteId}
					value={note}
					spellCheck={false}
					onChange={(event) => setNote(event.target.value)}
				/>
			</EditorField>

			{(draft.error ?? error) ? (
				<p role="alert" className="text-destructive text-sm">
					{draft.error ?? error}
				</p>
			) : null}

			<footer className="flex items-center gap-2 pt-1">
				<button
					type="submit"
					disabled={submitting || draft.value === null}
					className="rounded-md bg-primary px-3.5 py-2 font-medium text-primary-foreground text-sm disabled:opacity-50"
				>
					{submitting ? "Saving…" : "Save correction"}
				</button>
				<button
					type="button"
					disabled={submitting}
					onClick={onCancel}
					className="ml-auto py-1.5 text-muted-foreground text-sm disabled:opacity-50"
				>
					Cancel
				</button>
			</footer>
		</form>
	);
}
