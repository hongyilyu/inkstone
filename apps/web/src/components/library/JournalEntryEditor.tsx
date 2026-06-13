import type { EntityMutateParams } from "@inkstone/protocol";
import { X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type JournalEntry,
	type JournalEntryBodyNode,
	localNowString,
} from "@/lib/libraryItems";
import { EditorField, EditorInput, EntityEditorFrame } from "./EntityEditor.js";

type Props = (
	| { mode: "create"; journalEntry?: undefined }
	| { mode: "edit"; journalEntry: JournalEntry }
) & {
	/** Called with the affected Journal Entry id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/**
 * The editable body: text segments are mutable strings; chips are immutable
 * references the user can only keep or remove (adding new chips is slice-9).
 */
interface DraftBodyNode {
	type: "text" | "entity_ref";
	/** For text nodes: the editable text. */
	text?: string;
	/** For entity_ref nodes: the stored `ref_id` (snake_case on the wire). */
	refId?: string;
	/** A human label for the chip token. */
	label?: string;
}

interface Draft {
	/** Local wall-clock `YYYY-MM-DDTHH:MM` (datetime-local value). */
	occurredAt: string;
	endedAt: string;
	body: DraftBodyNode[];
}

/** A 16-char datetime-local value (`…THH:MM`) → the 19-char string Core wants. */
function localToWallClock(value: string): string {
	return `${value}:00`;
}

/**
 * Resolve the wall-clock string to emit for a time the user may not have touched.
 * `datetime-local` only carries minute precision, so a stored value with nonzero
 * seconds would be re-stamped to `:00` on any save — silent mutation of an
 * untouched field. When the input still matches the stored value's minute prefix,
 * emit the stored string verbatim (seconds preserved); otherwise emit the edit.
 */
function emitWallClock(value: string, stored: string | undefined): string {
	if (stored && wallClockToLocal(stored) === value) return stored;
	return localToWallClock(value);
}

/** A stored 19-char wall-clock string → the 16-char datetime-local value. */
function wallClockToLocal(value: string): string {
	return value.slice(0, 16);
}

function chipLabel(
	node: Extract<JournalEntryBodyNode, { type: "entity_ref" }>,
) {
	return node.targetTitle ?? node.labelSnapshot ?? "Referenced entity";
}

function draftFromJournalEntry(entry: JournalEntry | undefined): Draft {
	if (!entry) {
		return {
			occurredAt: wallClockToLocal(localNowString()),
			endedAt: "",
			body: [{ type: "text", text: "" }],
		};
	}
	return {
		occurredAt: wallClockToLocal(entry.occurredAt),
		endedAt: entry.endedAt ? wallClockToLocal(entry.endedAt) : "",
		body: entry.body.map((node) =>
			node.type === "text"
				? { type: "text", text: node.text }
				: { type: "entity_ref", refId: node.refId, label: chipLabel(node) },
		),
	};
}

/**
 * The wire body for the draft, dropping empty text segments and mapping kept
 * chips to snake_case `{type:"entity_ref", ref_id}` carrying the REAL stored id
 * (slice-6 bug class — never leak camelCase `refId`). Empty when nothing remains.
 */
function buildBody(
	body: DraftBodyNode[],
): Array<
	{ type: "text"; text: string } | { type: "entity_ref"; ref_id: string }
> {
	const nodes: Array<
		{ type: "text"; text: string } | { type: "entity_ref"; ref_id: string }
	> = [];
	for (const node of body) {
		if (node.type === "text") {
			const text = node.text ?? "";
			if (text.trim() !== "") nodes.push({ type: "text", text });
		} else if (node.refId) {
			nodes.push({ type: "entity_ref", ref_id: node.refId });
		}
	}
	return nodes;
}

function buildCreateParams(d: Draft): EntityMutateParams {
	const payload: Record<string, unknown> = {
		occurred_at: localToWallClock(d.occurredAt),
		body: buildBody(d.body),
	};
	if (d.endedAt) payload.ended_at = localToWallClock(d.endedAt);
	return { mutation_kind: "create_journal_entry", payload };
}

/**
 * `update_journal_entry` is a FULL REPLACE (slice-8): emit the complete intended
 * state — occurred_at, ended_at (when set), and the whole body (kept chips +
 * edited text). A removed chip is simply absent from `body`.
 */
function buildUpdateParams(entry: JournalEntry, d: Draft): EntityMutateParams {
	const payload: Record<string, unknown> = {
		entity_id: entry.id,
		occurred_at: emitWallClock(d.occurredAt, entry.occurredAt),
		body: buildBody(d.body),
	};
	if (d.endedAt) payload.ended_at = emitWallClock(d.endedAt, entry.endedAt);
	return { mutation_kind: "update_journal_entry", payload };
}

/** Create / edit a Journal Entry inline in the (widened) Library rail (ADR-0033). */
export function JournalEntryEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.journalEntry : undefined;
	const [draft, setDraft] = useState<Draft>(() =>
		draftFromJournalEntry(existing),
	);
	const mutation = useEntityMutation();

	const ids = { occurred: useId(), ended: useId() };

	const setText = (index: number, text: string) =>
		setDraft((d) => ({
			...d,
			body: d.body.map((node, i) => (i === index ? { ...node, text } : node)),
		}));

	const removeChip = (index: number) =>
		setDraft((d) => ({
			...d,
			body: d.body.filter((_, i) => i !== index),
		}));

	const occurredEmpty = draft.occurredAt.trim() === "";
	const bodyEmpty = buildBody(draft.body).length === 0;
	const blocked = occurredEmpty || bodyEmpty;

	const submit = () => {
		if (blocked) return;
		const params = existing
			? buildUpdateParams(existing, draft)
			: buildCreateParams(draft);
		mutation.mutate(params, {
			onSuccess: (result) =>
				onDone(result.entity_id ?? existing?.id ?? draft.occurredAt),
		});
	};

	const error =
		mutation.error == null
			? null
			: mutation.error instanceof Error
				? mutation.error.message
				: "Couldn't save. Try again.";

	return (
		<EntityEditorFrame
			title={existing ? "Edit Journal Entry" : "New Journal Entry"}
			onSubmit={submit}
			onCancel={onCancel}
			saving={mutation.isPending}
			error={error}
		>
			<EditorField label="Occurred at" htmlFor={ids.occurred}>
				<EditorInput
					id={ids.occurred}
					type="datetime-local"
					value={draft.occurredAt}
					onChange={(e) =>
						setDraft((d) => ({ ...d, occurredAt: e.target.value }))
					}
				/>
			</EditorField>

			<EditorField label="Ended at" htmlFor={ids.ended}>
				<EditorInput
					id={ids.ended}
					type="datetime-local"
					value={draft.endedAt}
					onChange={(e) => setDraft((d) => ({ ...d, endedAt: e.target.value }))}
				/>
			</EditorField>

			<BodyEditor
				body={draft.body}
				onText={setText}
				onRemoveChip={removeChip}
			/>
		</EntityEditorFrame>
	);
}

/**
 * The body as editable text segments interleaved with removable chip tokens.
 * Full rich inline editing is out of scope (slice-8): this supports editing text,
 * keeping chips, and removing chips — enough to emit a valid non-empty body.
 */
function BodyEditor({
	body,
	onText,
	onRemoveChip,
}: {
	body: DraftBodyNode[];
	onText: (index: number, text: string) => void;
	onRemoveChip: (index: number) => void;
}) {
	// Each text segment is its own labeled control ("Body"); chips are read-only
	// tokens with a remove button. No outer group label so a single-segment body
	// resolves to exactly one "Body" control.
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">Body</span>
			<div className="flex flex-col gap-2">
				{body.map((node, index) =>
					node.type === "text" ? (
						<EditorInput
							// biome-ignore lint/suspicious/noArrayIndexKey: body is a positional list; nodes have no stable id.
							key={`text-${index}`}
							aria-label="Body"
							value={node.text ?? ""}
							placeholder="What happened?"
							onChange={(e) => onText(index, e.target.value)}
						/>
					) : (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: body is a positional list; nodes have no stable id.
							key={`chip-${index}`}
							className="flex items-center gap-2 rounded-lg border border-input bg-card/40 px-3 py-2"
						>
							<span className="min-w-0 flex-1 truncate text-foreground text-sm">
								{node.label}
							</span>
							<Button
								type="button"
								variant="icon"
								size="icon"
								aria-label={`Remove ${node.label}`}
								onClick={() => onRemoveChip(index)}
							>
								<X className="size-3.5" aria-hidden />
							</Button>
						</div>
					),
				)}
			</div>
		</div>
	);
}
