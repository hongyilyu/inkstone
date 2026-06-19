import { Link2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
	buildBody,
	buildJournalEntry,
	buildJournalReference,
	type DraftBodyNode,
	type JournalDraft,
	journalDraftFromVm,
	journalScalarsDiffer,
	REFERENCEABLE_KINDS,
	type ReferenceableKind,
	stagedNewChip,
} from "@/lib/entityCodec.js";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type JournalEntry,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemSubtitle,
	libraryItemTitle,
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

/** Create / edit a Journal Entry inline in the (widened) Library rail (ADR-0033). */
export function JournalEntryEditor({ onDone, onCancel, ...m }: Props) {
	const existing = m.mode === "edit" ? m.journalEntry : undefined;
	const allEntities = m.mode === "edit" ? m.allEntities : [];
	const [draft, setDraft] = useState<JournalDraft>(() =>
		journalDraftFromVm(existing),
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

	const dropStagedPlaceholder = () =>
		// Drop the just-saved placeholder so a follow-up chip is its OWN mutation —
		// never two placeholders in one reference body (Core collapses them onto one
		// minted ref_id ⇒ data loss).
		setDraft((d) => ({
			...d,
			body: d.body.filter(
				(node) => node.type === "text" || node.newTargetId === undefined,
			),
		}));

	const submit = () => {
		if (blocked) return;
		// A staged new chip is its OWN reference mutation (mints a ref_id), distinct
		// from update_journal_entry (whose entity_ref nodes need an existing ref_id).
		const referencing = existing !== undefined && newChip !== undefined;
		if (!referencing) {
			const params = existing
				? buildJournalEntry({ mode: "update", existing, draft })
				: buildJournalEntry({ mode: "create", draft });
			mutation.mutate(params, {
				onSuccess: (result) =>
					onDone(result.entity_id ?? existing?.id ?? draft.occurredAt),
			});
			return;
		}
		// biome-ignore lint/style/noNonNullAssertion: referencing guarantees both.
		const entry = existing!;
		// biome-ignore lint/style/noNonNullAssertion: referencing guarantees both.
		const chip = newChip!;
		// The reference mutation carries NO scalars, so a date edit made in the same
		// Save would be lost. Persist it FIRST via update_journal_entry (awaited),
		// THEN reference the chip — so the user never silently loses a date edit.
		const referenceParams = buildJournalReference(entry, draft, chip);
		const run = async () => {
			if (journalScalarsDiffer(entry, draft)) {
				await mutation.mutateAsync(
					buildJournalEntry({
						mode: "update",
						existing: entry,
						draft,
					}),
				);
			}
			const result = await mutation.mutateAsync(referenceParams);
			dropStagedPlaceholder();
			onDone(result.entity_id ?? entry.id);
		};
		// A rejected mutation already surfaces via `mutation.error`; nothing more to do.
		run().catch(() => {});
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
			canSave={!blocked}
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
