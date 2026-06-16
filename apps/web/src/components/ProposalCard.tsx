import {
	CalendarDays,
	Check,
	Loader2,
	type LucideIcon,
	Pencil,
	RotateCcw,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { KIND_META } from "@/lib/libraryItems";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	overlayCreatePerson,
	overlayCreateProject,
	overlayCreateTodo,
	type ProjectEditStatus,
	seedCreatePerson,
	seedCreateProject,
	seedCreateTodo,
	type TodoEditStatus,
} from "@/lib/proposalEdit";
import type { PendingProposal } from "@/store/chat";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
} from "./library/EntityEditor.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

const TODO_STATUS_OPTIONS: { value: TodoEditStatus; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
];

// Reuses the Library ProjectEditor's STATUS_OPTIONS labels — Project has `on_hold`,
// which Todo lacks.
const PROJECT_STATUS_OPTIONS: { value: ProjectEditStatus; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "on_hold", label: "On hold" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
];

// The 8 mutation kinds the Worker proposes (ADR-0025). Bookmarks and direct
// entity-edits are user-CRUD-only (ADR-0033/0036) — never proposed — so the card
// has never rendered them; an unrecognized kind degrades through `fallbackView`.
type ProposalKind =
	| "create_journal_entry"
	| "update_journal_entry"
	| "delete_journal_entry"
	| "reference_existing_entity_from_journal_entry"
	| "create_person"
	| "create_project"
	| "create_todo"
	| "update_todo";

// Per-kind presentation for a Proposal — the review card's analogue of KIND_META
// (lib/libraryItems): one entry concentrates the copy, labels, glyph, and
// edit-ability that distinguish one proposal kind from another, so a new kind is
// one new row instead of a fork threaded through a dozen ternaries. Glyphs reuse
// the canonical entity iconography (KIND_META) so a Person proposal wears the same
// mark it has in the Library, palette, and detail panels; kinds differ by glyph +
// label, never colour alone (PRODUCT.md a11y).
interface ProposalView {
	/** Header glyph — the canonical entity mark. */
	glyph: LucideIcon;
	/** Accept-button glyph — GTD kinds show their entity mark, journal kinds a calendar. */
	acceptGlyph: LucideIcon;
	/**
	 * The card's bold summary line, read from the (unvalidated) payload through the
	 * defensive helpers so a malformed payload degrades rather than crashes
	 * (the wire keeps the payload opaque — ADR-0009/0014).
	 */
	summary: (payload: unknown) => string;
	/** Muted review prompt shown above the summary. */
	reviewCopy: string;
	/** Confirmation copy once the Proposal is accepted / rejected. */
	acceptedCopy: string;
	rejectedCopy: string;
	/** Accept-button label, and its in-flight variant. */
	acceptLabel: string;
	acceptBusyLabel: string;
	/** Reject-button label, and its in-flight variant. */
	rejectLabel: string;
	rejectBusyLabel: string;
	/**
	 * Whether the inline Edit affordance is offered: only journal create/update, and
	 * only when the body carries no entity_ref (no GTD editor in V0). A function of
	 * the already-read `bodyHasEntityRef` rather than the raw payload.
	 */
	canEdit: (bodyHasEntityRef: boolean) => boolean;
}

const PROPOSAL_VIEWS: Record<ProposalKind, ProposalView> = {
	create_journal_entry: {
		glyph: KIND_META.journal_entry.icon,
		acceptGlyph: CalendarDays,
		summary: (payload) => journalBody(payload) || "Untitled entry",
		reviewCopy: "Inkstone wants to create a Journal Entry.",
		acceptedCopy: "Added to Journal.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Add Journal Entry",
		acceptBusyLabel: "Adding...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: (bodyHasEntityRef) => !bodyHasEntityRef,
	},
	update_journal_entry: {
		glyph: KIND_META.journal_entry.icon,
		acceptGlyph: CalendarDays,
		summary: () => "Update Journal Entry",
		reviewCopy: "Inkstone wants to update a Journal Entry.",
		acceptedCopy: "Updated in Journal.",
		rejectedCopy: "Kept current Journal Entry.",
		acceptLabel: "Update Journal Entry",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Keep current entry",
		rejectBusyLabel: "Keeping current entry...",
		canEdit: (bodyHasEntityRef) => !bodyHasEntityRef,
	},
	delete_journal_entry: {
		glyph: KIND_META.journal_entry.icon,
		acceptGlyph: CalendarDays,
		summary: () => "Delete Journal Entry",
		reviewCopy: "Inkstone wants to delete a Journal Entry.",
		acceptedCopy: "Deleted from Journal.",
		rejectedCopy: "Kept in Journal.",
		acceptLabel: "Delete Journal Entry",
		acceptBusyLabel: "Deleting...",
		rejectLabel: "Keep Journal Entry",
		rejectBusyLabel: "Keeping...",
		canEdit: () => false,
	},
	reference_existing_entity_from_journal_entry: {
		glyph: KIND_META.journal_entry.icon,
		acceptGlyph: CalendarDays,
		summary: () => "Reference existing Entity",
		reviewCopy:
			"Inkstone wants to link an accepted Entity from this Journal Entry.",
		acceptedCopy: "Linked in Journal.",
		rejectedCopy: "Kept current Journal Entry.",
		acceptLabel: "Link Entity",
		acceptBusyLabel: "Linking...",
		rejectLabel: "Keep current entry",
		rejectBusyLabel: "Keeping current entry...",
		canEdit: () => false,
	},
	create_person: {
		glyph: KIND_META.person.icon,
		acceptGlyph: KIND_META.person.icon,
		summary: (payload) => textField(payload, "name") || "New Person",
		reviewCopy: "Inkstone wants to add a Person.",
		acceptedCopy: "Added Person.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Add Person",
		acceptBusyLabel: "Adding...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
	},
	create_project: {
		glyph: KIND_META.project.icon,
		acceptGlyph: KIND_META.project.icon,
		summary: (payload) => textField(payload, "name") || "New Project",
		reviewCopy: "Inkstone wants to add a Project.",
		acceptedCopy: "Added Project.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Add Project",
		acceptBusyLabel: "Adding...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
	},
	create_todo: {
		glyph: KIND_META.todo.icon,
		acceptGlyph: KIND_META.todo.icon,
		summary: (payload) =>
			textField(objectField(payload, "todo"), "title") || "New Todo",
		reviewCopy: "Inkstone wants to add a Todo.",
		acceptedCopy: "Added Todo.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Add Todo",
		acceptBusyLabel: "Adding...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
	},
	update_todo: {
		glyph: KIND_META.todo.icon,
		acceptGlyph: KIND_META.todo.icon,
		summary: () => "Update Todo",
		reviewCopy: "Inkstone wants to update a Todo.",
		acceptedCopy: "Updated Todo.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Update Todo",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => false,
	},
};

// An unrecognized kind renders like a generic Journal-Entry create, echoing the
// raw kind into the review prompt. Unreachable by contract — the Worker only
// proposes the 8 kinds above — but `mutation_kind` is a bare string on the wire
// (ADR-0014), so the card stays legible rather than blank if one slips through.
function fallbackView(kind: string): ProposalView {
	return {
		glyph: KIND_META.journal_entry.icon,
		acceptGlyph: CalendarDays,
		summary: (payload) => journalBody(payload) || "Untitled entry",
		reviewCopy: `Inkstone wants to create a ${kind}.`,
		acceptedCopy: "Added to Journal.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Add Journal Entry",
		acceptBusyLabel: "Adding...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => false,
	};
}

function proposalView(mutationKind: string): ProposalView {
	// Gate on OWN membership, not a bare `??`: `mutation_kind` is an unvalidated
	// wire string (ADR-0014), and indexing the record with a prototype key
	// ("toString", "constructor", …) would return an inherited Object.prototype
	// member — truthy, so `?? fallbackView` would NOT fire and the card would
	// crash reading `.summary` off a function. `Object.hasOwn` degrades every
	// non-own key through the fallback.
	return Object.hasOwn(PROPOSAL_VIEWS, mutationKind)
		? PROPOSAL_VIEWS[mutationKind as ProposalKind]
		: fallbackView(mutationKind);
}

type JournalEntryPayload = {
	occurred_at: string;
	ended_at?: string;
	body: Array<
		{ type: "text"; text: string } | { type: "entity_ref"; ref_id?: string }
	>;
};

type UpdateJournalEntryPayload = JournalEntryPayload & {
	entity_id: string;
};

// The wire payload is `unknown` — Core forwards the raw, unvalidated model
// arguments (the GTD validators live in crates/core/src/entities.rs and run on
// accept, not before the card renders). A malformed payload (missing fields,
// null, wrong types) must degrade, so the renderers read every field through
// the defensive helpers below rather than asserting a typed shape.

function textField(payload: unknown, key: string): string {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		return typeof value === "string" ? value : "";
	}
	return "";
}

/** Read `key` as an object, degrading a missing/null/non-object value to null. */
function objectField(
	payload: unknown,
	key: string,
): Record<string, unknown> | null {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return null;
}

/** Read `key` as an array, degrading a missing/null/non-array value to []. */
function arrayField(payload: unknown, key: string): unknown[] {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}

function journalBody(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const body = (payload as Record<string, unknown>).body;
	if (!Array.isArray(body)) return "";
	return body
		.map((node) => {
			if (!node || typeof node !== "object") return "";
			const record = node as Record<string, unknown>;
			if (record.type === "entity_ref") return "[entity_ref]";
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("");
}

function journalBodyHasEntityRef(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const body = (payload as Record<string, unknown>).body;
	if (!Array.isArray(body)) return false;
	return body.some((node) => {
		if (!node || typeof node !== "object") return false;
		return (node as Record<string, unknown>).type === "entity_ref";
	});
}

function journalPayload(
	occurredAt: string,
	bodyText: string,
	endedAt: string,
): JournalEntryPayload {
	return {
		occurred_at: occurredAt.trim(),
		...(endedAt.trim() ? { ended_at: endedAt.trim() } : {}),
		body: [{ type: "text", text: bodyText.trim() }],
	};
}

function isLocalDateTime(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value.trim());
}

function journalPayloadIssue(
	occurredAt: string,
	bodyText: string,
	endedAt: string,
	entityId?: string,
): string | null {
	if (entityId !== undefined && entityId.trim().length === 0) {
		return "entity id must not be empty";
	}
	const occurred = occurredAt.trim();
	const ended = endedAt.trim();
	if (!isLocalDateTime(occurred)) {
		return "occurred at must use YYYY-MM-DDTHH:MM:SS";
	}
	if (ended.length > 0 && !isLocalDateTime(ended)) {
		return "ended at must use YYYY-MM-DDTHH:MM:SS";
	}
	if (ended.length > 0 && ended < occurred) {
		// Lexicographic order matches chronological order for YYYY-MM-DDTHH:MM:SS.
		return "ended at must be after occurred at";
	}
	if (bodyText.trim().length === 0) {
		return "body must not be empty";
	}
	return null;
}

type EditedPayload =
	| JournalEntryPayload
	| UpdateJournalEntryPayload
	| Record<string, unknown>;

export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: (
		decision: "accept" | "reject" | "edit",
		editedPayload?: EditedPayload,
	) => void;
}) {
	const editFormId = useId();
	const occurredAtInputId = `${editFormId}-proposal-edit-occurred-at`;
	const endedAtInputId = `${editFormId}-proposal-edit-ended-at`;
	const bodyInputId = `${editFormId}-proposal-edit-body`;
	const todoTitleInputId = `${editFormId}-proposal-edit-todo-title`;
	const todoNoteInputId = `${editFormId}-proposal-edit-todo-note`;
	const todoStatusInputId = `${editFormId}-proposal-edit-todo-status`;
	const personNameInputId = `${editFormId}-proposal-edit-person-name`;
	const personNoteInputId = `${editFormId}-proposal-edit-person-note`;
	const personAliasesInputId = `${editFormId}-proposal-edit-person-aliases`;
	const projectNameInputId = `${editFormId}-proposal-edit-project-name`;
	const projectOutcomeInputId = `${editFormId}-proposal-edit-project-outcome`;
	const projectNoteInputId = `${editFormId}-proposal-edit-project-note`;
	const projectStatusInputId = `${editFormId}-proposal-edit-project-status`;
	const { status, payload, rationale, mutation_kind } = proposal;
	const occurredAt = textField(payload, "occurred_at");
	const endedAt = textField(payload, "ended_at");
	const bodyText = journalBody(payload);
	const entityId = textField(payload, "entity_id");
	const currentJournalEntry = proposal.review_context?.current_journal_entry;
	const currentOccurredAt = textField(currentJournalEntry, "occurred_at");
	const currentEndedAt = textField(currentJournalEntry, "ended_at");
	const currentBodyText = journalBody(currentJournalEntry);
	const bodyHasEntityRef =
		journalBodyHasEntityRef(payload) ||
		journalBodyHasEntityRef(currentJournalEntry);
	// Retained because OUT-OF-SCOPE code consumes them: the journal payload
	// validation below reads create/update; the journal detail-render gates on
	// create/update/delete; the GTD detail-render gates on `isGtdProposal`. The
	// per-kind copy/labels/glyph these once drove now live in PROPOSAL_VIEWS.
	const isCreateProposal = mutation_kind === "create_journal_entry";
	const isUpdateProposal = mutation_kind === "update_journal_entry";
	const isDeleteProposal = mutation_kind === "delete_journal_entry";
	// The GTD kinds that render their own inline edit form (vs the journal form).
	const isCreateTodo = mutation_kind === "create_todo";
	const isCreatePerson = mutation_kind === "create_person";
	const isCreateProject = mutation_kind === "create_project";
	// A GTD create that surfaces an inline edit form (todo/person/project). update_todo
	// renders read-only — it has no inline editor yet.
	const isGtdEdit = isCreateTodo || isCreatePerson || isCreateProject;
	const isGtdProposal =
		mutation_kind === "create_person" ||
		mutation_kind === "create_project" ||
		mutation_kind === "create_todo" ||
		mutation_kind === "update_todo";
	// The single resolved presentation entry: header glyph, accept-button glyph,
	// summary, review/accepted/rejected copy, accept/reject labels (+ busy variants),
	// and edit-ability all read from here instead of a per-kind ternary.
	const view = proposalView(mutation_kind);
	const HeaderGlyph = view.glyph;
	const AcceptGlyph = view.acceptGlyph;
	const summary = view.summary(payload);
	const reviewCopy = view.reviewCopy;
	const acceptedCopy = view.acceptedCopy;
	const rejectedCopy = view.rejectedCopy;
	const acceptLabel = view.acceptLabel;
	const acceptBusyLabel = view.acceptBusyLabel;
	const rejectLabel = view.rejectLabel;
	const rejectBusyLabel = view.rejectBusyLabel;
	const canEdit = view.canEdit(bodyHasEntityRef);
	const payloadIssue = isCreateProposal
		? journalPayloadIssue(occurredAt, bodyText, endedAt)
		: isUpdateProposal
			? journalPayloadIssue(occurredAt, bodyText, endedAt, entityId)
			: null;
	// GTD cards carry no journal-style payload validation — they are always applyable.
	const canApply = payloadIssue === null;

	const [inFlight, setInFlight] = useState<"accept" | "reject" | "edit" | null>(
		null,
	);
	useEffect(() => {
		if (proposal.status !== "deciding") setInFlight(null);
	}, [proposal.status]);
	// Last decision attempted, retained across `deciding → error` so retry re-issues the SAME decision. See docs/design/web-chat-ui.md.
	const lastAttempt = useRef<{
		decision: "accept" | "reject" | "edit";
		editedPayload?: EditedPayload;
	} | null>(null);
	const decide = (decision: "accept" | "reject") => {
		setInFlight(decision);
		lastAttempt.current = { decision };
		onDecide(decision);
	};
	const retry = () => {
		const attempt = lastAttempt.current ?? { decision: "accept" as const };
		setInFlight(attempt.decision);
		if (attempt.editedPayload !== undefined) {
			onDecide(attempt.decision, attempt.editedPayload);
		} else {
			onDecide(attempt.decision);
		}
	};

	const [editing, setEditing] = useState(false);
	const [editOccurredAt, setEditOccurredAt] = useState(occurredAt);
	const [editEndedAt, setEditEndedAt] = useState(endedAt);
	const [editBody, setEditBody] = useState(bodyText);
	// Each GTD create form's surfaced fields (seeded from the proposed payload on
	// open). The journal kinds reuse the journal form; update_todo can't edit yet.
	const [todoDraft, setTodoDraft] = useState<CreateTodoDraft>(() =>
		seedCreateTodo(payload),
	);
	const [personDraft, setPersonDraft] = useState<CreatePersonDraft>(() =>
		seedCreatePerson(payload),
	);
	const [projectDraft, setProjectDraft] = useState<CreateProjectDraft>(() =>
		seedCreateProject(payload),
	);
	const editIssue = isCreateProposal
		? journalPayloadIssue(editOccurredAt, editBody, editEndedAt)
		: isUpdateProposal
			? journalPayloadIssue(editOccurredAt, editBody, editEndedAt, entityId)
			: null;
	// Required-field gate for each GTD create form: Save is disabled when the
	// required field (Todo title / Person+Project name) is blank.
	const todoTitleEmpty = todoDraft.title.trim() === "";
	const personNameEmpty = personDraft.name.trim() === "";
	const projectNameEmpty = projectDraft.name.trim() === "";
	// The single required-field gate the GTD Save reads, by kind.
	const gtdRequiredEmpty = isCreateTodo
		? todoTitleEmpty
		: isCreatePerson
			? personNameEmpty
			: projectNameEmpty;
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const openEdit = () => {
		if (!canEdit) return;
		if (isCreateTodo) {
			setTodoDraft(seedCreateTodo(payload));
		} else if (isCreatePerson) {
			setPersonDraft(seedCreatePerson(payload));
		} else if (isCreateProject) {
			setProjectDraft(seedCreateProject(payload));
		} else {
			setEditOccurredAt(occurredAt);
			setEditEndedAt(endedAt);
			setEditBody(bodyText);
		}
		setEditing(true);
	};
	useEffect(() => {
		// The journal form focuses its body textarea on open; each GTD form focuses
		// its required field via the input's autoFocus (EditorInput forwards no ref).
		if (editing && !isGtdEdit) bodyRef.current?.focus();
	}, [editing, isGtdEdit]);
	const saveEdit = () => {
		if (inFlight !== null || proposal.status === "deciding") return;
		if (editIssue !== null) return;
		const editedPayload = journalPayload(editOccurredAt, editBody, editEndedAt);
		const decisionPayload = entityId
			? { entity_id: entityId, ...editedPayload }
			: editedPayload;
		setInFlight("edit");
		setEditing(false);
		lastAttempt.current = { decision: "edit", editedPayload: decisionPayload };
		onDecide("edit", decisionPayload);
	};
	// Route each GTD create kind to its pure overlay (proposalEdit), commit as a
	// single edit decision through the same inFlight/lastAttempt/retry plumbing as
	// the journal form. Save is gated on the kind's required field.
	const saveGtdEdit = () => {
		if (inFlight !== null || proposal.status === "deciding") return;
		if (gtdRequiredEmpty) return;
		const decisionPayload = isCreateTodo
			? overlayCreateTodo(payload, todoDraft)
			: isCreatePerson
				? overlayCreatePerson(payload, personDraft)
				: overlayCreateProject(payload, projectDraft);
		setInFlight("edit");
		setEditing(false);
		lastAttempt.current = { decision: "edit", editedPayload: decisionPayload };
		onDecide("edit", decisionPayload);
	};

	if (status === "accepted" || status === "rejected") {
		const accepted = status === "accepted";
		return (
			<Card
				data-proposal={proposal.run_id}
				data-proposal-status={status}
				className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200"
			>
				{accepted ? (
					<Check className="size-4 text-card-foreground/60" aria-hidden />
				) : null}
				<span aria-live="polite">{accepted ? acceptedCopy : rejectedCopy}</span>
			</Card>
		);
	}

	const deciding = status === "deciding";
	const submitting = deciding || inFlight !== null;
	const isError = status === "error";

	return (
		<Card
			data-proposal={proposal.run_id}
			data-proposal-status={status}
			className="flex flex-col gap-3 p-4 motion-safe:transition-opacity motion-safe:duration-200"
		>
			<header className="flex items-center gap-2.5">
				<span
					className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
					aria-hidden
				>
					<HeaderGlyph className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="text-xs font-medium text-muted-foreground">
						{reviewCopy}
					</p>
					<p className="truncate text-sm font-semibold text-card-foreground">
						{summary}
					</p>
				</div>
			</header>

			{editing ? (
				isGtdEdit ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							saveGtdEdit();
						}}
						className="flex flex-col gap-3 border-border border-t pt-3"
					>
						{/* One inline form per GTD create kind. Each surfaces exactly the
						    fields the user can change (approval-gate legibility); the
						    required field (Todo title / Person+Project name) autoFocuses on
						    open (mirrors the journal form focusing its body — autoFocus rides
						    through EditorInput → Input onto the real <input>). */}
						{isCreateTodo ? (
							<>
								<EditorField label="Title" htmlFor={todoTitleInputId}>
									<EditorInput
										id={todoTitleInputId}
										autoFocus
										value={todoDraft.title}
										onChange={(event) =>
											setTodoDraft((d) => ({ ...d, title: event.target.value }))
										}
									/>
								</EditorField>
								<EditorField label="Note" htmlFor={todoNoteInputId}>
									<EditorTextarea
										id={todoNoteInputId}
										value={todoDraft.note}
										onChange={(event) =>
											setTodoDraft((d) => ({ ...d, note: event.target.value }))
										}
									/>
								</EditorField>
								<EditorField label="Status" htmlFor={todoStatusInputId}>
									<EditorSelect
										id={todoStatusInputId}
										value={todoDraft.status}
										onChange={(event) =>
											setTodoDraft((d) => ({
												...d,
												status: event.target.value as TodoEditStatus,
											}))
										}
									>
										{TODO_STATUS_OPTIONS.map((o) => (
											<option key={o.value} value={o.value}>
												{o.label}
											</option>
										))}
									</EditorSelect>
								</EditorField>
							</>
						) : isCreatePerson ? (
							<>
								<EditorField label="Name" htmlFor={personNameInputId}>
									<EditorInput
										id={personNameInputId}
										autoFocus
										value={personDraft.name}
										onChange={(event) =>
											setPersonDraft((d) => ({
												...d,
												name: event.target.value,
											}))
										}
									/>
								</EditorField>
								<EditorField label="Note" htmlFor={personNoteInputId}>
									<EditorTextarea
										id={personNoteInputId}
										value={personDraft.note}
										onChange={(event) =>
											setPersonDraft((d) => ({
												...d,
												note: event.target.value,
											}))
										}
									/>
								</EditorField>
								<EditorField label="Aliases" htmlFor={personAliasesInputId}>
									<EditorInput
										id={personAliasesInputId}
										value={personDraft.aliases}
										placeholder="Other names, comma-separated"
										onChange={(event) =>
											setPersonDraft((d) => ({
												...d,
												aliases: event.target.value,
											}))
										}
									/>
								</EditorField>
							</>
						) : (
							<>
								<EditorField label="Name" htmlFor={projectNameInputId}>
									<EditorInput
										id={projectNameInputId}
										autoFocus
										value={projectDraft.name}
										onChange={(event) =>
											setProjectDraft((d) => ({
												...d,
												name: event.target.value,
											}))
										}
									/>
								</EditorField>
								<EditorField label="Outcome" htmlFor={projectOutcomeInputId}>
									<EditorTextarea
										id={projectOutcomeInputId}
										value={projectDraft.outcome}
										onChange={(event) =>
											setProjectDraft((d) => ({
												...d,
												outcome: event.target.value,
											}))
										}
									/>
								</EditorField>
								<EditorField label="Note" htmlFor={projectNoteInputId}>
									<EditorTextarea
										id={projectNoteInputId}
										value={projectDraft.note}
										onChange={(event) =>
											setProjectDraft((d) => ({
												...d,
												note: event.target.value,
											}))
										}
									/>
								</EditorField>
								<EditorField label="Status" htmlFor={projectStatusInputId}>
									<EditorSelect
										id={projectStatusInputId}
										value={projectDraft.status}
										onChange={(event) =>
											setProjectDraft((d) => ({
												...d,
												status: event.target.value as ProjectEditStatus,
											}))
										}
									>
										{PROJECT_STATUS_OPTIONS.map((o) => (
											<option key={o.value} value={o.value}>
												{o.label}
											</option>
										))}
									</EditorSelect>
								</EditorField>
							</>
						)}
						<footer className="flex items-center gap-2 pt-1">
							<button
								type="submit"
								disabled={submitting || gtdRequiredEmpty}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Check className="size-4" aria-hidden />
								Save changes
							</button>
							<button
								type="button"
								disabled={submitting}
								onClick={() => setEditing(false)}
								className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								Cancel
							</button>
						</footer>
					</form>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							saveEdit();
						}}
						className="flex flex-col gap-3 border-border border-t pt-3"
					>
						<label
							className="flex flex-col gap-1.5"
							htmlFor={occurredAtInputId}
						>
							<span className="text-xs font-medium text-muted-foreground">
								Occurred at
							</span>
							<Input
								id={occurredAtInputId}
								value={editOccurredAt}
								onChange={(event) => setEditOccurredAt(event.target.value)}
								className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
							/>
						</label>
						<label className="flex flex-col gap-1.5" htmlFor={endedAtInputId}>
							<span className="text-xs font-medium text-muted-foreground">
								Ended at
							</span>
							<Input
								id={endedAtInputId}
								value={editEndedAt}
								onChange={(event) => setEditEndedAt(event.target.value)}
								className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
							/>
						</label>
						<label className="flex flex-col gap-1.5" htmlFor={bodyInputId}>
							<span className="text-xs font-medium text-muted-foreground">
								Body
							</span>
							<textarea
								id={bodyInputId}
								ref={bodyRef}
								value={editBody}
								onChange={(event) => setEditBody(event.target.value)}
								className="min-h-24 rounded-lg border border-input bg-card-surface/40 px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
							/>
						</label>
						{editIssue ? (
							<p role="alert" className="text-sm text-destructive">
								Edit required fields: {editIssue}.
							</p>
						) : null}
						<footer className="flex items-center gap-2 pt-1">
							<button
								type="submit"
								disabled={submitting || editIssue !== null}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Check className="size-4" aria-hidden />
								Save changes
							</button>
							<button
								type="button"
								disabled={submitting}
								onClick={() => setEditing(false)}
								className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								Cancel
							</button>
						</footer>
					</form>
				)
			) : (
				<>
					{isCreateProposal || isUpdateProposal || isDeleteProposal ? (
						<div className="flex flex-col gap-3 border-border border-t pt-3">
							{isUpdateProposal || isDeleteProposal ? (
								currentJournalEntry ? (
									<EntrySection
										title="Current entry"
										occurredAt={currentOccurredAt}
										endedAt={currentEndedAt}
										bodyText={currentBodyText}
									/>
								) : isDeleteProposal ? (
									<p className="text-muted-foreground text-sm">
										Current entry details unavailable.
									</p>
								) : null
							) : null}
							{isCreateProposal || isUpdateProposal ? (
								<EntrySection
									title="Proposed entry"
									occurredAt={occurredAt}
									endedAt={endedAt}
									bodyText={bodyText}
								/>
							) : null}
						</div>
					) : null}

					{isGtdProposal ? (
						<div className="flex flex-col gap-3 border-border border-t pt-3">
							<GtdSection mutationKind={mutation_kind} payload={payload} />
						</div>
					) : null}

					{rationale ? (
						<p className="text-sm leading-relaxed text-muted-foreground">
							{rationale}
						</p>
					) : null}

					{isError ? (
						<p role="alert" className="text-sm text-destructive">
							{payloadIssue
								? `Edit required fields: ${payloadIssue}.`
								: "Couldn't apply. Try again."}
						</p>
					) : payloadIssue ? (
						<p role="alert" className="text-sm text-destructive">
							Edit required fields: {payloadIssue}.
						</p>
					) : null}

					<footer className="flex items-center gap-2 pt-1">
						{isError ? (
							<button
								type="button"
								// Gate retry on what it will re-send: reject always allowed; a stored edit on its payload; a plain accept on `canApply`. See docs/design/web-chat-ui.md.
								disabled={
									lastAttempt.current?.decision === "reject"
										? false
										: lastAttempt.current?.decision === "edit"
											? lastAttempt.current.editedPayload === undefined
											: !canApply
								}
								onClick={retry}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								<RotateCcw className="size-4" aria-hidden />
								Try again
							</button>
						) : (
							<button
								type="button"
								disabled={submitting || !canApply}
								onClick={() => decide("accept")}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								{deciding && inFlight === "accept" ? (
									<>
										<Loader2
											className="size-4 motion-safe:animate-spin"
											aria-hidden
										/>
										{acceptBusyLabel}
									</>
								) : (
									<>
										<AcceptGlyph className="size-4" aria-hidden />
										{acceptLabel}
									</>
								)}
							</button>
						)}

						{canEdit ? (
							<button
								type="button"
								disabled={submitting}
								onClick={openEdit}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-input px-3 py-1.5 font-medium text-foreground/80 text-sm transition-colors hover:bg-secondary/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Pencil className="size-3.5" aria-hidden />
								Edit
							</button>
						) : null}

						<button
							type="button"
							disabled={submitting}
							onClick={() => decide("reject")}
							className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							{deciding && inFlight === "reject" ? (
								<>
									<Loader2
										className="size-3.5 motion-safe:animate-spin"
										aria-hidden
									/>
									{rejectBusyLabel}
								</>
							) : (
								rejectLabel
							)}
						</button>
					</footer>
				</>
			)}
		</Card>
	);
}

function EntrySection({
	title,
	occurredAt,
	endedAt,
	bodyText,
}: {
	title: string;
	occurredAt: string;
	endedAt: string;
	bodyText: string;
}) {
	return (
		<section className="flex flex-col gap-2">
			<p className="text-xs font-medium tracking-normal text-muted-foreground">
				{title}
			</p>
			<dl className="flex flex-col gap-1.5 text-sm">
				<Field label="Occurred" value={occurredAt || "Unknown"} />
				{endedAt ? <Field label="Ended" value={endedAt} /> : null}
				<Field label="Body" value={bodyText || "Empty"} />
			</dl>
		</section>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<dt className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
				{label}
			</dt>
			<dd className="min-w-0 text-card-foreground">{value}</dd>
		</div>
	);
}

// A person ref is itself unvalidated; read its id/role defensively. Returns null
// when there is no usable person_id so the caller can skip rendering a blank row.
function personRefLine(ref: unknown): string | null {
	const personId = textField(ref, "person_id");
	if (!personId) return null;
	const role = textField(ref, "role");
	return role === "waiting_on"
		? `Waiting on: ${personId}`
		: `Related: ${personId}`;
}

// Map an array field of (unvalidated) person refs to rendered rows. Rows are
// static and presentational, so the post-filter index is a unique, stable key —
// it avoids a duplicate-key collision when two refs share the same id + role
// (reachable since the payload is raw, unvalidated model output).
function personRefFields(
	payload: unknown,
	key: string,
	prefix: string,
	label: string,
) {
	// Key by the row's own value plus a per-value occurrence counter rather than a
	// bare array index (Biome noArrayIndexKey): stable across payload reordering,
	// and still unique when two unvalidated refs render the identical line.
	const seen = new Map<string, number>();
	return arrayField(payload, key)
		.map((ref) => personRefLine(ref))
		.filter((line): line is string => line !== null)
		.map((line) => {
			const nth = seen.get(line) ?? 0;
			seen.set(line, nth + 1);
			return (
				<Field key={`${prefix}:${line}:${nth}`} label={label} value={line} />
			);
		});
}

function GtdSection({
	mutationKind,
	payload,
}: {
	mutationKind: string;
	payload: unknown;
}) {
	if (mutationKind === "create_person") {
		const note = textField(payload, "note");
		const aliases = arrayField(payload, "aliases").filter(
			(a): a is string => typeof a === "string",
		);
		return (
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Person
				</p>
				<dl className="flex flex-col gap-1.5 text-sm">
					<Field label="Name" value={textField(payload, "name") || "Unknown"} />
					{note ? <Field label="Note" value={note} /> : null}
					{aliases.length > 0 ? (
						<Field label="Aliases" value={aliases.join(", ")} />
					) : null}
				</dl>
			</section>
		);
	}

	if (mutationKind === "create_project") {
		const outcome = textField(payload, "outcome");
		const status = textField(payload, "status");
		const note = textField(payload, "note");
		return (
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Project
				</p>
				<dl className="flex flex-col gap-1.5 text-sm">
					<Field label="Name" value={textField(payload, "name") || "Unknown"} />
					{outcome ? <Field label="Outcome" value={outcome} /> : null}
					{status ? <Field label="Status" value={status} /> : null}
					{note ? <Field label="Note" value={note} /> : null}
				</dl>
			</section>
		);
	}

	if (mutationKind === "create_todo") {
		const todo = objectField(payload, "todo");
		const note = textField(todo, "note");
		const status = textField(todo, "status");
		const projectId = textField(todo, "project_id");
		return (
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Todo
				</p>
				<dl className="flex flex-col gap-1.5 text-sm">
					<Field label="Title" value={textField(todo, "title") || "Untitled"} />
					{note ? <Field label="Note" value={note} /> : null}
					{status ? <Field label="Status" value={status} /> : null}
					{projectId ? <Field label="Project" value={projectId} /> : null}
					{personRefFields(payload, "person_refs", "ref", "People")}
				</dl>
			</section>
		);
	}

	// update_todo
	const todo = objectField(payload, "todo");
	const title = textField(todo, "title");
	const note = textField(todo, "note");
	const status = textField(todo, "status");
	const projectId = textField(todo, "project_id");
	const removeIds = arrayField(payload, "remove_person_ids").filter(
		(id): id is string => typeof id === "string",
	);
	return (
		<section className="flex flex-col gap-2">
			<p className="text-xs font-medium tracking-normal text-muted-foreground">
				Changes
			</p>
			<dl className="flex flex-col gap-1.5 text-sm">
				<Field
					label="Todo"
					value={textField(payload, "todo_id") || "Unknown"}
				/>
				{title ? <Field label="Title" value={title} /> : null}
				{note ? <Field label="Note" value={note} /> : null}
				{status ? <Field label="Status" value={status} /> : null}
				{projectId ? <Field label="Project" value={projectId} /> : null}
				{personRefFields(payload, "set_person_refs", "set", "Set")}
				{personRefFields(payload, "add_person_refs", "add", "Add")}
				{removeIds.length > 0 ? (
					<Field label="Remove" value={removeIds.join(", ")} />
				) : null}
			</dl>
		</section>
	);
}
