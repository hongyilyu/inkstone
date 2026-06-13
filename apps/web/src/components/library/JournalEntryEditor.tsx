import type { EntityMutateParams } from "@inkstone/protocol";
import { Link2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type JournalEntry,
	type JournalEntryBodyNode,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemSubtitle,
	libraryItemTitle,
	localNowString,
} from "@/lib/libraryItems";
import { EditorField, EditorInput, EntityEditorFrame } from "./EntityEditor.js";
import { EntityGlyph } from "./EntityGlyph.js";

type Props = (
	| { mode: "create"; journalEntry?: undefined; allEntities?: undefined }
	| { mode: "edit"; journalEntry: JournalEntry; allEntities: LibraryItem[] }
) & {
	/** Called with the affected Journal Entry id after a successful save. */
	onDone: (id: string) => void;
	onCancel: () => void;
};

/** The Entity kinds an inline chip may target (ADR-0030; never a Journal Entry). */
type ReferenceableKind = "person" | "project" | "todo";
const REFERENCEABLE_KINDS: ReferenceableKind[] = ["person", "project", "todo"];

/**
 * The editable body: text segments are mutable strings; chips are references.
 * Existing chips carry a real `refId`; a NEWLY added chip is a bare placeholder
 * carrying its `targetEntityId` (no ref_id — Core mints one on the reference
 * mutation). At most one new chip is staged at a time (one reference mutation
 * per new chip — the hard contract). Discriminated on `type`.
 */
type DraftEntityRefNode = {
	type: "entity_ref";
	/** For existing chips: the stored `ref_id` (snake_case on the wire). */
	refId?: string;
	/** A human label for the chip token. */
	label?: string;
	/** For a NEW chip: the picked Entity's id (the reference target). */
	newTargetId?: string;
};

type DraftBodyNode = { type: "text"; text: string } | DraftEntityRefNode;

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
			if (node.text.trim() !== "")
				nodes.push({ type: "text", text: node.text });
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

/** The single staged new chip (the one bare placeholder), or undefined. */
function stagedNewChip(body: DraftBodyNode[]): DraftEntityRefNode | undefined {
	return body.find(
		(node): node is DraftEntityRefNode =>
			node.type === "entity_ref" && node.newTargetId !== undefined,
	);
}

/**
 * The wire body for a reference mutation: the JE's text nodes plus the ONE new
 * chip as a BARE `{type:"entity_ref"}` placeholder (Core mints its ref_id and
 * rewrites the placeholder). Core rejects any `ref_id` on a reference body node
 * and rewrites EVERY placeholder to the same minted id, so this body carries no
 * `ref_id` node and exactly one placeholder. Add-a-chip is gated to chip-free
 * entries (see `AddReferenceField`), so no existing chip is ever present here.
 */
function buildReferenceBody(
	body: DraftBodyNode[],
): Array<{ type: "text"; text: string } | { type: "entity_ref" }> {
	const nodes: Array<{ type: "text"; text: string } | { type: "entity_ref" }> =
		[];
	for (const node of body) {
		if (node.type === "text") {
			if (node.text.trim() !== "")
				nodes.push({ type: "text", text: node.text });
		} else if (node.newTargetId !== undefined) {
			nodes.push({ type: "entity_ref" });
		}
	}
	return nodes;
}

/**
 * `reference_existing_entity_from_journal_entry` for the ONE staged new chip:
 * the JE is the source, the picked Entity the target, and the body carries
 * exactly one bare placeholder for the new chip (ADR-0030/0033).
 */
function buildReferenceParams(
	entry: JournalEntry,
	d: Draft,
	chip: DraftEntityRefNode,
): EntityMutateParams {
	const payload: Record<string, unknown> = {
		source_entity_id: entry.id,
		target_entity_id: chip.newTargetId,
		body: buildReferenceBody(d.body),
	};
	if (chip.label) payload.label_snapshot = chip.label;
	return {
		mutation_kind: "reference_existing_entity_from_journal_entry",
		payload,
	};
}

/** Create / edit a Journal Entry inline in the (widened) Library rail (ADR-0033). */
export function JournalEntryEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.journalEntry : undefined;
	const allEntities = m.mode === "edit" ? m.allEntities : [];
	const [draft, setDraft] = useState<Draft>(() =>
		draftFromJournalEntry(existing),
	);
	const mutation = useEntityMutation();

	const ids = { occurred: useId(), ended: useId() };

	const setText = (index: number, text: string) =>
		setDraft((d) => ({
			...d,
			body: d.body.map((node, i) =>
				i === index && node.type === "text" ? { ...node, text } : node,
			),
		}));

	const removeChip = (index: number) =>
		setDraft((d) => ({
			...d,
			body: d.body.filter((_, i) => i !== index),
		}));

	// Stage ONE new chip: append a placeholder carrying the picked target.
	const addChip = (target: LibraryItem) =>
		setDraft((d) => ({
			...d,
			body: [
				...d.body,
				{
					type: "entity_ref",
					newTargetId: target.id,
					label: libraryItemTitle(target),
				},
			],
		}));

	const newChip = stagedNewChip(draft.body);
	// Core supports at most one chip per JE via reference_existing (its body must
	// carry exactly one bare placeholder and the mutation full-replaces the body).
	// So add-a-chip is gated to chip-free entries.
	const hasExistingChip = draft.body.some(
		(node) => node.type === "entity_ref" && node.refId !== undefined,
	);
	const occurredEmpty = draft.occurredAt.trim() === "";
	const bodyEmpty = buildBody(draft.body).length === 0 && newChip === undefined;
	const blocked = occurredEmpty || bodyEmpty;

	const submit = () => {
		if (blocked) return;
		// A staged new chip is its OWN reference mutation (mints a ref_id), distinct
		// from update_journal_entry (whose entity_ref nodes need an existing ref_id).
		const referencing = existing !== undefined && newChip !== undefined;
		const params = referencing
			? // biome-ignore lint/style/noNonNullAssertion: referencing guarantees both.
				buildReferenceParams(existing!, draft, newChip!)
			: existing
				? buildUpdateParams(existing, draft)
				: buildCreateParams(draft);
		mutation.mutate(params, {
			onSuccess: (result) => {
				// Drop the just-saved placeholder so a follow-up chip is its OWN
				// mutation — never two placeholders in one reference body (Core
				// collapses them onto one minted ref_id ⇒ data loss).
				if (referencing) {
					setDraft((d) => ({
						...d,
						body: d.body.filter(
							(node) => node.type === "text" || node.newTargetId === undefined,
						),
					}));
				}
				onDone(result.entity_id ?? existing?.id ?? draft.occurredAt);
			},
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

			{existing ? (
				<AddReferenceField
					allEntities={allEntities}
					hasExistingChip={hasExistingChip}
					hasStagedChip={newChip !== undefined}
					onPick={addChip}
				/>
			) : null}
		</EntityEditorFrame>
	);
}

/**
 * The "add a reference" affordance (edit only): a button opens a searchable pick
 * of Person/Project/Todo (never a Journal Entry). Picking stages ONE new chip,
 * which is its own reference mutation (a bare placeholder Core mints a ref_id
 * for). Core supports at most one chip per JE through this mutation, so the
 * affordance is gated to chip-FREE entries: an entry that already carries a chip
 * shows a hint instead (the chip can still be removed/edited via update).
 */
function AddReferenceField({
	allEntities,
	hasExistingChip,
	hasStagedChip,
	onPick,
}: {
	allEntities: LibraryItem[];
	hasExistingChip: boolean;
	hasStagedChip: boolean;
	onPick: (target: LibraryItem) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const inputId = useId();

	const candidates = useMemo(
		() =>
			allEntities.filter((e): e is LibraryItem & { kind: ReferenceableKind } =>
				(REFERENCEABLE_KINDS as readonly LibraryItemKind[]).includes(e.kind),
			),
		[allEntities],
	);
	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		const pool = q
			? candidates.filter((e) => libraryItemTitle(e).toLowerCase().includes(q))
			: candidates;
		return pool.slice(0, 8);
	}, [candidates, query]);

	if (hasExistingChip) {
		// This JE already has a chip; Core takes one reference per entry. Remove
		// the existing chip (an update) first to add a different one.
		return (
			<p className="text-muted-foreground text-xs">
				One reference per entry for now.
			</p>
		);
	}

	if (hasStagedChip) {
		// One new chip staged: it shows in the body above; save it to persist the
		// reference. Core takes one reference per entry, so the picker stays closed.
		return (
			<p className="text-muted-foreground text-xs">
				Save to add the reference.
			</p>
		);
	}

	if (!open) {
		return (
			<Button
				type="button"
				variant="chip"
				size="sm"
				className="self-start"
				onClick={() => setOpen(true)}
			>
				<Link2 className="size-3.5" aria-hidden />
				Add reference
			</Button>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<EditorInput
				id={inputId}
				aria-label="Link an entity"
				placeholder="Search People, Projects, Todos…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<div className="flex flex-col gap-1" role="listbox">
				{matches.length === 0 ? (
					<p className="px-1 py-2 text-muted-foreground text-sm">
						No matching entities.
					</p>
				) : (
					matches.map((entity) => (
						<button
							key={entity.id}
							type="button"
							role="option"
							aria-selected={false}
							aria-label={libraryItemTitle(entity)}
							className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
							onClick={() => {
								onPick(entity);
								setOpen(false);
								setQuery("");
							}}
						>
							<EntityGlyph entity={entity} size="sm" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-foreground text-sm">
									{libraryItemTitle(entity)}
								</span>
								<span className="block truncate text-muted-foreground text-xs">
									{libraryItemSubtitle(entity)}
								</span>
							</span>
						</button>
					))
				)}
			</div>
		</div>
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
