import { ObservationRecordParams } from "@inkstone/protocol";
import { Either, Schema as S } from "effect";
import { Check } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { EditorField, EditorTextarea } from "./library/EntityEditor.js";
import { arrayField, objectField, textField } from "./proposalPayload.js";
import { Button } from "./ui/button.js";

const decodeObservationRecordParams = S.decodeUnknownEither(
	ObservationRecordParams,
);

function unknownField(payload: unknown, key: string): unknown {
	if (payload && typeof payload === "object" && key in payload) {
		return (payload as Record<string, unknown>)[key];
	}
	return undefined;
}

function observationValueText(value: unknown): string {
	if (value === undefined) return "Unknown";
	return JSON.stringify(value) ?? "Unknown";
}

export function observationBatchSummary(payload: unknown): string {
	const observations = arrayField(payload, "observations");
	if (observations.length === 0) return "Observations";
	if (observations.length === 1) {
		return textField(observations[0], "schema_key") || "1 observation";
	}
	return `${observations.length} observations`;
}

function observationEvidenceText(payload: unknown): string {
	const evidence = objectField(payload, "evidence");
	const journalEntryId = textField(evidence, "journal_entry_id");
	if (journalEntryId) return `Journal Entry: ${journalEntryId}`;
	const messageId = textField(evidence, "message_id");
	if (messageId) return `Message: ${messageId}`;
	return "";
}

function ObservationField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<dt className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
				{label}
			</dt>
			<dd className="min-w-0 text-card-foreground">{value}</dd>
		</div>
	);
}

export function renderObservationBody({
	payload,
}: {
	payload: unknown;
}): ReactNode {
	const observations = arrayField(payload, "observations");
	const evidence = observationEvidenceText(payload);
	const seen = new Map<string, number>();
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Observations
				</p>
				{observations.length > 0 ? (
					<div className="flex flex-col gap-3">
						{observations.map((observation, position) => {
							const schemaKey =
								textField(observation, "schema_key") || "Observation";
							const occurredAt = textField(observation, "occurred_at");
							const endedAt = textField(observation, "ended_at");
							const note = textField(observation, "note");
							const values = observationValueText(
								unknownField(observation, "values"),
							);
							const keySeed = `${schemaKey}:${occurredAt}:${values}`;
							const nth = seen.get(keySeed) ?? 0;
							seen.set(keySeed, nth + 1);
							return (
								<dl
									key={`${keySeed}:${nth}`}
									className="flex flex-col gap-1.5 text-sm"
								>
									<ObservationField
										label="Schema"
										value={
											observations.length === 1
												? schemaKey
												: `${position + 1}. ${schemaKey}`
										}
									/>
									<ObservationField
										label="Occurred"
										value={occurredAt || "Unknown"}
									/>
									{endedAt ? (
										<ObservationField label="Ended" value={endedAt} />
									) : null}
									<ObservationField label="Values" value={values} />
									{note ? <ObservationField label="Note" value={note} /> : null}
								</dl>
							);
						})}
					</div>
				) : (
					<p className="text-muted-foreground text-sm">
						Observation details unavailable.
					</p>
				)}
			</section>
			{evidence ? (
				<section className="flex flex-col gap-2">
					<p className="text-xs font-medium tracking-normal text-muted-foreground">
						Evidence
					</p>
					<dl className="flex flex-col gap-1.5 text-sm">
						<ObservationField label="Source" value={evidence} />
					</dl>
				</section>
			) : null}
		</div>
	);
}

function prettyJson(value: unknown): string {
	return JSON.stringify(value ?? {}, null, 2) ?? "{}";
}

function parseJsonObject(
	text: string,
):
	| { value: Record<string, unknown>; error: null }
	| { value: null; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { value: null, error: "payload must be valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { value: null, error: "payload must be a JSON object" };
	}
	const decoded = decodeObservationRecordParams(parsed);
	if (Either.isLeft(decoded)) {
		return {
			value: null,
			error: "payload must match the record_observations schema",
		};
	}
	return { value: parsed as Record<string, unknown>, error: null };
}

export function ObservationEditForm({
	payload,
	submitting,
	onSave,
	onCancel,
}: {
	payload: unknown;
	submitting: boolean;
	onSave: (editedPayload: Record<string, unknown>) => void;
	onCancel: () => void;
}): ReactNode {
	const payloadInputId = useId();
	const [text, setText] = useState(() => prettyJson(payload));
	const parsed = useMemo(() => parseJsonObject(text), [text]);
	const submit = () => {
		if (submitting || parsed.value === null) return;
		onSave(parsed.value);
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			className="flex flex-col gap-3 border-border border-t pt-3"
		>
			<EditorField label="Payload" htmlFor={payloadInputId}>
				<EditorTextarea
					id={payloadInputId}
					autoFocus
					value={text}
					spellCheck={false}
					onChange={(event) => setText(event.target.value)}
				/>
			</EditorField>
			{parsed.error ? (
				<p role="alert" className="text-sm text-destructive">
					Edit required fields: {parsed.error}.
				</p>
			) : null}
			<footer className="flex items-center gap-2 pt-1">
				<Button
					type="submit"
					variant="primary"
					size="row"
					className="gap-1.5 px-3.5 py-2"
					disabled={submitting || parsed.value === null}
				>
					<Check className="size-4" aria-hidden />
					Save changes
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto py-1.5 text-sm"
					disabled={submitting}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</footer>
		</form>
	);
}
