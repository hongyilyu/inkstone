import type {
	NodeDecision,
	ProposalReviewContext,
	ResolvedNode,
} from "@inkstone/protocol";
import {
	CalendarDays,
	Check,
	GitBranch,
	Loader2,
	type LucideIcon,
	Pencil,
	Plus,
	RotateCcw,
	TriangleAlert,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	allRejected,
	buildDecisions,
	buildEditedFields,
	type DraftBuffer,
	downgradeNotices,
	draftLabel,
	draftRequiredEmpty,
	type GraphNodeDraft,
	hasAmbiguous,
	isAcceptable,
	parseGraphEntities,
	parseGraphLinks,
	type RepointBuffer,
	rejectAll,
	repointFor,
	type StagingBuffer,
	seedNodeDraft,
	setStage,
	stageFor,
} from "@/lib/intentGraphReview";
import { KIND_META, type LibraryItemKind } from "@/lib/libraryItems";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	overlayCreatePerson,
	overlayCreateProject,
	overlayCreateTodo,
	overlayUpdatePerson,
	overlayUpdateProject,
	overlayUpdateTodo,
	type ProjectEditStatus,
	seedCreatePerson,
	seedCreateProject,
	seedCreateTodo,
	seedUpdatePerson,
	seedUpdateProject,
	seedUpdateTodo,
	type TodoEditStatus,
	type UpdateTodoDraft,
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

// The mutation kinds the Worker proposes (ADR-0025). Bookmarks and direct
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
	| "update_todo"
	| "update_person"
	| "update_project"
	| "apply_intent_graph";

/**
 * Inputs a row's `renderBody` strategy reads to draw the card's detail body — the
 * opaque wire `payload` and the optional review context (the latter carries the
 * current Journal Entry for update/delete diffs). Both are read through the
 * defensive helpers, never a typed decode (ADR-0009/0014).
 */
interface ProposalBodyArgs {
	payload: unknown;
	reviewContext: ProposalReviewContext | undefined;
}

// Per-kind presentation for a Proposal — the review card's analogue of KIND_META
// (lib/libraryItems): one entry concentrates the copy, labels, glyph,
// edit-ability, and detail-body render that distinguish one proposal kind from
// another, so a new kind is one new row instead of a fork threaded through a dozen
// ternaries. Glyphs reuse the canonical entity iconography (KIND_META) so a Person
// proposal wears the same mark it has in the Library, palette, and detail panels;
// kinds differ by glyph + label, never colour alone (PRODUCT.md a11y).
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
	 * Whether the inline Edit affordance is offered. Journal create/update gate on
	 * the body carrying no entity_ref (the `bodyHasEntityRef` arg); every GTD
	 * create/update kind is always editable and ignores the arg. Delete, the
	 * reference weave, and the fallback view are never editable. A function of the
	 * already-read `bodyHasEntityRef` rather than the raw payload.
	 */
	canEdit: (bodyHasEntityRef: boolean) => boolean;
	/**
	 * The card's detail body, read from the (unvalidated) payload — and, for
	 * update/delete journal diffs, `reviewContext.current_journal_entry` — through
	 * the defensive helpers. Returns `null` for kinds with no detail body
	 * (reference, and the fallback).
	 */
	renderBody: (args: ProposalBodyArgs) => ReactNode;
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
		renderBody: (args) => renderJournalBody(args, "create"),
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
		renderBody: (args) => renderJournalBody(args, "update"),
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
		renderBody: (args) => renderJournalBody(args, "delete"),
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
		renderBody: renderNoBody,
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
		renderBody: renderPersonBody,
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
		renderBody: renderProjectBody,
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
		renderBody: renderCreateTodoBody,
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
		canEdit: () => true,
		renderBody: renderUpdateTodoBody,
	},
	update_person: {
		glyph: KIND_META.person.icon,
		acceptGlyph: KIND_META.person.icon,
		summary: (payload) => textField(payload, "name") || "Update Person",
		reviewCopy: "Inkstone wants to update a Person.",
		acceptedCopy: "Updated Person.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Update Person",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
		// Full-document REPLACE: the proposed payload is the whole new Person body
		// (the entity_id rides untouched, not surfaced), so its read-only detail
		// mirrors create_person's.
		renderBody: renderPersonBody,
	},
	update_project: {
		glyph: KIND_META.project.icon,
		acceptGlyph: KIND_META.project.icon,
		summary: (payload) => textField(payload, "name") || "Update Project",
		reviewCopy: "Inkstone wants to update a Project.",
		acceptedCopy: "Updated Project.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Update Project",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
		// Full-document REPLACE: read-only detail mirrors create_project's.
		renderBody: renderProjectBody,
	},
	apply_intent_graph: {
		// The graph card renders its OWN body + footer (the sequential review queue
		// + staging buffer, ADR-0042) — these fields supply only the header glyph +
		// copy. `renderBody`/accept/reject labels are unused (the graph branch in
		// ProposalCard short-circuits before the single-entity render path).
		glyph: GitBranch,
		acceptGlyph: Check,
		summary: () => "Review extracted items",
		reviewCopy: "Inkstone recognized these from your note.",
		acceptedCopy: "Applied.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Apply",
		acceptBusyLabel: "Applying...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => false,
		renderBody: renderNoBody,
	},
};

// An unrecognized kind renders like a generic Journal-Entry create, echoing the
// raw kind into the review prompt. Unreachable by contract — the Worker only
// proposes the 8 kinds above — but `mutation_kind` is a bare string on the wire
// (ADR-0014), so the card stays legible rather than blank if one slips through.
// No detail body: the raw payload's shape is unknown for an unrecognized kind, so
// rendering a Journal diff risks a spurious "Proposed entry" block (or worse).
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
		renderBody: renderNoBody,
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

type DecideHandler = (
	decision: "accept" | "reject" | "edit",
	editedPayload?: EditedPayload,
	decisions?: readonly NodeDecision[],
) => void;

/**
 * The review card for a pending Proposal. A pure dispatcher (no hooks of its own)
 * so the two decision models live in separate components with their own hook
 * order: the intent graph (ADR-0042) is a sequential review queue with a local
 * staging buffer and ONE atomic commit, every other kind is the scalar
 * accept/edit/reject single-entity card.
 */
export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: DecideHandler;
}) {
	if (proposal.mutation_kind === "apply_intent_graph") {
		return <IntentGraphReviewCard proposal={proposal} onDecide={onDecide} />;
	}
	return <SingleEntityProposalCard proposal={proposal} onDecide={onDecide} />;
}

function SingleEntityProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: DecideHandler;
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
	const bodyHasEntityRef =
		journalBodyHasEntityRef(payload) ||
		journalBodyHasEntityRef(currentJournalEntry);
	// Retained for journal-payload validation only: `payloadIssue` (accept gate)
	// and `editIssue` (Save gate) read create/update to pick which validator runs.
	// The detail-body routing these once also drove now lives in `view.renderBody`.
	const isCreateProposal = mutation_kind === "create_journal_entry";
	const isUpdateProposal = mutation_kind === "update_journal_entry";
	// The GTD kinds that render their own inline edit form (vs the journal form).
	const isCreateTodo = mutation_kind === "create_todo";
	const isCreatePerson = mutation_kind === "create_person";
	const isCreateProject = mutation_kind === "create_project";
	// update_todo edits the proposed PARTIAL in place (title/note, status only when
	// the partial already carries one); todo_id + the three ref lists ride untouched.
	const isUpdateTodo = mutation_kind === "update_todo";
	// update_person/update_project are FULL-DOCUMENT REPLACE: the proposed payload is
	// the whole new entity body plus a top-level entity_id, so they reuse the
	// create_person/create_project inline forms (same surfaced fields + overlay logic;
	// the entity_id rides untouched through the overlay clone).
	const isUpdatePerson = mutation_kind === "update_person";
	const isUpdateProject = mutation_kind === "update_project";
	// The person/project inline forms back BOTH their create and update (full-replace)
	// kinds — identical surfaced fields, so one form each, keyed by these booleans.
	const showPersonForm = isCreatePerson || isUpdatePerson;
	const showProjectForm = isCreateProject || isUpdateProject;
	// A GTD kind that surfaces an inline edit form (the creates + the updates).
	const isGtdEdit =
		isCreateTodo || showPersonForm || showProjectForm || isUpdateTodo;
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
	// Each GTD form's surfaced fields (seeded from the proposed payload on open). The
	// journal kinds reuse the journal form. The person/project drafts back both the
	// create and the full-replace update kinds — the update seed reads the same
	// surfaced fields, so the create seed is the right initial value either way.
	const [todoDraft, setTodoDraft] = useState<CreateTodoDraft>(() =>
		seedCreateTodo(payload),
	);
	const [personDraft, setPersonDraft] = useState<CreatePersonDraft>(() =>
		seedCreatePerson(payload),
	);
	const [projectDraft, setProjectDraft] = useState<CreateProjectDraft>(() =>
		seedCreateProject(payload),
	);
	const [updateTodoDraft, setUpdateTodoDraft] = useState<UpdateTodoDraft>(() =>
		seedUpdateTodo(payload),
	);
	const editIssue = isCreateProposal
		? journalPayloadIssue(editOccurredAt, editBody, editEndedAt)
		: isUpdateProposal
			? journalPayloadIssue(editOccurredAt, editBody, editEndedAt, entityId)
			: null;
	// Required-field gate for each GTD form: Save is disabled when the required field
	// (Todo title / Person+Project name) is blank.
	const todoTitleEmpty = todoDraft.title.trim() === "";
	const personNameEmpty = personDraft.name.trim() === "";
	const projectNameEmpty = projectDraft.name.trim() === "";
	// update_todo: title is required ONLY when the partial proposed one (setting an
	// existing title to "" would be invalid). A partial with no title key has no
	// title field to gate, so Save stays enabled.
	const updateTodoTitleEmpty =
		updateTodoDraft.titlePresent && updateTodoDraft.title.trim() === "";
	// The single required-field gate the GTD Save reads, by form. update_person/
	// update_project share the create person/project gates (name required).
	const gtdRequiredEmpty = isCreateTodo
		? todoTitleEmpty
		: showPersonForm
			? personNameEmpty
			: showProjectForm
				? projectNameEmpty
				: updateTodoTitleEmpty;
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const openEdit = () => {
		if (!canEdit) return;
		if (isCreateTodo) {
			setTodoDraft(seedCreateTodo(payload));
		} else if (showPersonForm) {
			setPersonDraft(
				isUpdatePerson ? seedUpdatePerson(payload) : seedCreatePerson(payload),
			);
		} else if (showProjectForm) {
			setProjectDraft(
				isUpdateProject
					? seedUpdateProject(payload)
					: seedCreateProject(payload),
			);
		} else if (isUpdateTodo) {
			setUpdateTodoDraft(seedUpdateTodo(payload));
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
	// Route each GTD kind to its pure overlay (proposalEdit), commit as a single edit
	// decision through the same inFlight/lastAttempt/retry plumbing as the journal
	// form. Save is gated on the kind's required field. update_person/update_project
	// reuse the person/project drafts but route to their full-replace overlays (which
	// preserve the top-level entity_id + any unsurfaced field).
	const saveGtdEdit = () => {
		if (inFlight !== null || proposal.status === "deciding") return;
		if (gtdRequiredEmpty) return;
		const decisionPayload = isCreateTodo
			? overlayCreateTodo(payload, todoDraft)
			: showPersonForm
				? (isUpdatePerson ? overlayUpdatePerson : overlayCreatePerson)(
						payload,
						personDraft,
					)
				: showProjectForm
					? (isUpdateProject ? overlayUpdateProject : overlayCreateProject)(
							payload,
							projectDraft,
						)
					: overlayUpdateTodo(payload, updateTodoDraft);
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
						{/* One inline form per GTD form (the person/project forms back both
						    their create and full-replace update kinds). Each surfaces exactly
						    the fields the user can change (approval-gate legibility); the
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
						) : showPersonForm ? (
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
						) : showProjectForm ? (
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
						) : (
							/* update_todo — edits the proposed PARTIAL in place. Title shows
							   only when the partial proposed one; Status shows only when the
							   partial carried a status (surfacing a select would inject an
							   unrequested field into the partial). Note is always surfaced. */
							<>
								{updateTodoDraft.titlePresent ? (
									<EditorField label="Title" htmlFor={todoTitleInputId}>
										<EditorInput
											id={todoTitleInputId}
											autoFocus
											value={updateTodoDraft.title}
											onChange={(event) =>
												setUpdateTodoDraft((d) => ({
													...d,
													title: event.target.value,
												}))
											}
										/>
									</EditorField>
								) : null}
								<EditorField label="Note" htmlFor={todoNoteInputId}>
									<EditorTextarea
										id={todoNoteInputId}
										autoFocus={!updateTodoDraft.titlePresent}
										value={updateTodoDraft.note}
										onChange={(event) =>
											setUpdateTodoDraft((d) => ({
												...d,
												note: event.target.value,
											}))
										}
									/>
								</EditorField>
								{updateTodoDraft.statusPresent ? (
									<EditorField label="Status" htmlFor={todoStatusInputId}>
										<EditorSelect
											id={todoStatusInputId}
											value={updateTodoDraft.status}
											onChange={(event) =>
												setUpdateTodoDraft((d) => ({
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
								) : null}
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
					{view.renderBody({
						payload,
						reviewContext: proposal.review_context,
					})}

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

// --- Intent-graph sequential review card (ADR-0042) -------------------------

const GRAPH_VIEW = PROPOSAL_VIEWS.apply_intent_graph;

/** Per-disposition badge copy + tone. Kinds differ by glyph + label, never colour
 * alone (PRODUCT.md a11y): each badge pairs a glyph with its word. `ambiguous`
 * wears the warning tone because it BLOCKS accept (no picker yet, #181). */
const DISPOSITION_BADGE: Record<
	ResolvedNode["disposition"],
	{ label: string; glyph: LucideIcon; className: string }
> = {
	create: {
		label: "New",
		glyph: Plus,
		className: "bg-secondary text-secondary-foreground",
	},
	reuse: {
		label: "Existing",
		glyph: Check,
		className: "bg-secondary text-secondary-foreground",
	},
	ambiguous: {
		label: "Needs disambiguation",
		glyph: TriangleAlert,
		className: "bg-destructive/10 text-destructive",
	},
};

/**
 * The `apply_intent_graph` review surface (ADR-0042): the whole resolved plan is
 * ONE Proposal, one park, one atomic commit, but the user reviews it node by node.
 * A local staging buffer (component state — NOT the chat store) accumulates each
 * node's accept/reject; nothing is sent until Apply, which commits ONE
 * `proposal/decide` carrying the `decisions[]` vector. An `ambiguous` node blocks
 * accept (reject-only until the picker ships, #181); rejecting a node a Todo links
 * to surfaces a downgrade notice before Apply.
 */
function IntentGraphReviewCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: DecideHandler;
}) {
	const plan = proposal.resolved_plan ?? [];
	const links = useMemo(
		() => parseGraphLinks(proposal.payload),
		[proposal.payload],
	);
	// The graph payload's `entities[]` carry each node's ORIGINAL proposed fields —
	// the seed an inline edit reads from and diffs the `edited_fields` correction
	// against. ResolvedNode is label-only, so the fields live here.
	const entities = useMemo(
		() => parseGraphEntities(proposal.payload),
		[proposal.payload],
	);
	// The staging buffer starts at the per-node defaults (acceptable → accept,
	// ambiguous → reject), so a plain Apply with no toggles accepts everything
	// resolvable — the common path.
	const [buffer, setBuffer] = useState<StagingBuffer>({});
	// Per-handle inline edit drafts for create nodes (ADR-0042 `edited_fields`). A
	// handle gains an entry when its row is opened for edit; the draft survives a
	// reject→accept toggle so a correction is not lost. `editingHandle` is the ONE
	// row currently expanded (one open at a time).
	const [drafts, setDrafts] = useState<DraftBuffer>({});
	const [editingHandle, setEditingHandle] = useState<string | null>(null);
	// Per-handle near-match re-point choices (ADR-0042 amendment). A create node
	// with a single near-match DEFAULTS to reusing that existing entity (no entry
	// needed — `repointFor` derives it); the buffer only records EXPLICIT user
	// overrides: a string id (a future picker pick) or `null` ("Create new instead",
	// suppressing the default). Mutually exclusive with an edit draft per node.
	const [repoints, setRepoints] = useState<RepointBuffer>({});
	const [inFlight, setInFlight] = useState<"commit" | "reject" | null>(null);
	// Reset the per-node staging when the proposal IDENTITY changes. The card is
	// keyed by run_id, not proposal_id, so a multi-step Run that parks a SECOND
	// `apply_intent_graph` proposal after a resume reuses this same mounted card
	// with a fresh proposal_id. The buffer is keyed by graph-local handles (ephemeral
	// model labels that collide across extractions), so without this reset a prior
	// graph's toggles could leak into the next and submit an unintended decision.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the proposal id.
	useEffect(() => {
		setBuffer({});
		setDrafts({});
		setEditingHandle(null);
		setRepoints({});
	}, [proposal.proposal_id]);
	useEffect(() => {
		if (proposal.status !== "deciding") setInFlight(null);
	}, [proposal.status]);

	const { status } = proposal;
	if (status === "accepted" || status === "rejected") {
		const accepted = status === "accepted";
		return (
			<Card
				data-proposal={proposal.run_id}
				data-proposal-status={status}
				data-proposal-kind="apply_intent_graph"
				className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200"
			>
				{accepted ? (
					<Check className="size-4 text-card-foreground/60" aria-hidden />
				) : null}
				<span aria-live="polite">
					{accepted ? GRAPH_VIEW.acceptedCopy : GRAPH_VIEW.rejectedCopy}
				</span>
			</Card>
		);
	}

	const deciding = status === "deciding";
	const submitting = deciding || inFlight !== null;
	const isError = status === "error";

	const notices = downgradeNotices(plan, links, buffer);
	const everythingRejected = plan.length > 0 && allRejected(plan, buffer);
	const acceptedCount = plan.filter(
		(node) => stageFor(buffer, node) === "accept",
	).length;
	const ambiguousPresent = hasAmbiguous(plan);

	const commit = () => {
		if (submitting) return;
		// A vector that rejects every node is a reject-all (Core declines the whole
		// graph); otherwise it is an accept carrying the per-node subset — each
		// accepted create node folding in its `edited_fields` correction, or its
		// near-match `entity_id` re-point (default-to-existing, ADR-0042 amendment).
		const decisions = buildDecisions(plan, buffer, drafts, entities, repoints);
		const decision = everythingRejected ? "reject" : "accept";
		setInFlight(everythingRejected ? "reject" : "commit");
		onDecide(decision, undefined, decisions);
	};
	const rejectEverything = () => {
		if (submitting) return;
		setBuffer(rejectAll(plan));
		setInFlight("reject");
		// A reject-all mints nothing, so no edited_fields ride along.
		onDecide("reject", undefined, buildDecisions(plan, rejectAll(plan)));
	};

	// Open one create node's inline edit form (one row at a time). The form holds its
	// own working draft; the card's `drafts` buffer gains an entry only on Save.
	const openEdit = (handle: string) => {
		if (submitting) return;
		setEditingHandle(handle);
	};
	// Save commits the working draft to the buffer and forces the node ACCEPT (an
	// edit only applies to a node you keep), then collapses the row.
	const saveEdit = (node: ResolvedNode, draft: GraphNodeDraft) => {
		setDrafts((current) => ({ ...current, [node.handle]: draft }));
		setBuffer((current) => setStage(current, node, "accept"));
		setEditingHandle(null);
	};
	// Cancel discards the working draft (the buffer is untouched) and collapses.
	const cancelEdit = () => setEditingHandle(null);

	// Near-match re-point toggles (ADR-0042 amendment, default-to-existing). A
	// single-near-match create node defaults to reusing its existing entity; these
	// record the EXPLICIT departures from that default. "Create new instead" sets
	// `null` (suppress the default → a plain create); "Reuse existing" clears the
	// override (back to the default re-point) — and discards any edit draft, since a
	// reused entity is linked-to, not minted/edited (mutually exclusive). (Named
	// `reuseExisting`, not `use*`, so it is not mistaken for a React hook.)
	const createNewInstead = (handle: string) => {
		if (submitting) return;
		setRepoints((current) => ({ ...current, [handle]: null }));
	};
	const reuseExisting = (node: ResolvedNode) => {
		if (submitting) return;
		// Clear the explicit override so the single-near-match default re-applies, and
		// drop any edit draft (a re-pointed node is reused, not edited).
		setRepoints((current) => {
			const { [node.handle]: _drop, ...rest } = current;
			return rest;
		});
		setDrafts((current) => {
			const { [node.handle]: _drop, ...rest } = current;
			return rest;
		});
		setBuffer((current) => setStage(current, node, "accept"));
	};

	const HeaderGlyph = GRAPH_VIEW.glyph;
	const commitLabel = everythingRejected
		? GRAPH_VIEW.rejectLabel
		: `Apply ${acceptedCount} ${acceptedCount === 1 ? "item" : "items"}`;

	return (
		<Card
			data-proposal={proposal.run_id}
			data-proposal-status={status}
			data-proposal-kind="apply_intent_graph"
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
						{GRAPH_VIEW.reviewCopy}
					</p>
					<p className="truncate text-sm font-semibold text-card-foreground">
						{plan.length} {plan.length === 1 ? "item" : "items"} to review
					</p>
				</div>
			</header>

			<ul className="flex flex-col gap-2 border-border border-t pt-3">
				{plan.map((node) => (
					<GraphNodeRow
						key={node.handle}
						node={node}
						stage={stageFor(buffer, node)}
						disabled={submitting}
						draft={drafts[node.handle]}
						seed={entities.get(node.handle)}
						editing={editingHandle === node.handle}
						repointId={repointFor(repoints, node)}
						onStage={(stage) =>
							setBuffer((current) => setStage(current, node, stage))
						}
						onEdit={() => openEdit(node.handle)}
						onSave={(draft) => saveEdit(node, draft)}
						onCancel={cancelEdit}
						onCreateNew={() => createNewInstead(node.handle)}
						onReuseExisting={() => reuseExisting(node)}
					/>
				))}
			</ul>

			{ambiguousPresent ? (
				<p className="text-xs text-muted-foreground">
					Some items match more than one existing entry. They can only be
					dismissed for now — disambiguation is coming soon.
				</p>
			) : null}

			{notices.length > 0 ? (
				<ul className="flex flex-col gap-1.5">
					{notices.map((notice) => (
						<li
							key={`${notice.todoHandle}:${notice.targetHandle}`}
							className="flex items-start gap-1.5 text-xs text-muted-foreground"
						>
							<TriangleAlert
								className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
								aria-hidden
							/>
							<span>{notice.message}</span>
						</li>
					))}
				</ul>
			) : null}

			{proposal.rationale ? (
				<p className="text-sm leading-relaxed text-muted-foreground">
					{proposal.rationale}
				</p>
			) : null}

			{isError ? (
				<p role="alert" className="text-sm text-destructive">
					Couldn't apply. Try again.
				</p>
			) : null}

			<footer className="flex items-center gap-2 pt-1">
				<button
					type="button"
					disabled={submitting || plan.length === 0}
					onClick={commit}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					{deciding && inFlight === "commit" ? (
						<>
							<Loader2
								className="size-4 motion-safe:animate-spin"
								aria-hidden
							/>
							{GRAPH_VIEW.acceptBusyLabel}
						</>
					) : (
						<>
							<Check className="size-4" aria-hidden />
							{commitLabel}
						</>
					)}
				</button>

				<button
					type="button"
					disabled={submitting}
					onClick={rejectEverything}
					className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					{deciding && inFlight === "reject" ? (
						<>
							<Loader2
								className="size-3.5 motion-safe:animate-spin"
								aria-hidden
							/>
							{GRAPH_VIEW.rejectBusyLabel}
						</>
					) : (
						"Dismiss all"
					)}
				</button>
			</footer>
		</Card>
	);
}

/** One node row in the intent-graph review queue: the entity glyph + label, a
 * create/reuse/ambiguous badge, and accept/reject toggles. A `create` node also
 * carries a pencil that expands the row INLINE into its per-type edit form (the
 * `edited_fields` correction); reuse/ambiguous nodes are not editable (Core rejects
 * an edit on a non-create node). An ambiguous node's accept is disabled (reject-only,
 * #181). When a draft is open the collapsed label reflects the edited name/title.
 *
 * Near-match (ADR-0042 amendment): a `create` node re-pointed onto an existing
 * entity (`repointId` set — the default for a single near-match) wears an
 * "Existing «…»" badge and a "Create new instead" escape, and is NOT editable
 * (you reuse it, not mint it). A create node with near-matches that the user has
 * sent back to "New" offers "Use existing «…»"; 2+ near-matches surface an
 * advisory note (no auto-pick — the picker is #181). */
function GraphNodeRow({
	node,
	stage,
	disabled,
	draft,
	seed,
	editing,
	repointId,
	onStage,
	onEdit,
	onSave,
	onCancel,
	onCreateNew,
	onReuseExisting,
}: {
	node: ResolvedNode;
	stage: "accept" | "reject";
	disabled: boolean;
	draft: GraphNodeDraft | undefined;
	seed: Record<string, unknown> | undefined;
	editing: boolean;
	repointId: string | null;
	onStage: (stage: "accept" | "reject") => void;
	onEdit: () => void;
	onSave: (draft: GraphNodeDraft) => void;
	onCancel: () => void;
	onCreateNew: () => void;
	onReuseExisting: () => void;
}) {
	const NodeGlyph = KIND_META[node.type as LibraryItemKind].icon;
	const rejected = stage === "reject";
	const nearMatches = node.near_matches ?? [];
	// A create node is re-pointed onto an existing entity when `repointId` resolves
	// (the single-near-match default, or a future picker pick). The re-point target's
	// label drives the "Existing «…»" badge; fall back to the id if it is not among
	// the listed near-matches (a picker could pick outside the list later).
	const repointed = node.disposition === "create" && repointId !== null;
	const repointLabel = repointed
		? (nearMatches.find((m) => m.entity_id === repointId)?.label ?? "existing")
		: null;
	// A re-pointed node REUSES its target, so it is not editable (a reuse is
	// linked-to, never rewritten — ADR-0030); editing stays on plain create nodes.
	const editable = node.disposition === "create" && !repointed;
	// The badge: a re-pointed node reads "Existing «target»" (reuse tone), else the
	// node's own disposition badge ("New"/"Existing"/"Needs disambiguation").
	const badge = repointed
		? {
				label: `Existing «${repointLabel}»`,
				glyph: Check,
				className: DISPOSITION_BADGE.reuse.className,
			}
		: DISPOSITION_BADGE[node.disposition];
	const BadgeGlyph = badge.glyph;
	const acceptable = isAcceptable(node);
	// The collapsed row shows the edited name/title once a draft is COMMITTED, so a
	// correction is visible without re-opening the form.
	const shownLabel =
		(draft !== undefined ? draftLabel(node, draft) : node.label) || node.handle;
	// "Edited" replaces the disposition badge only when the committed draft will
	// actually send an `edited_fields` correction — and only on an ACCEPTED node, since
	// a rejected node commits a plain reject (no edited_fields, see buildDecisions).
	// Opening + Save with no change stores a draft but sends a plain accept, so the
	// badge must still read "New". Both cases keep the badge honest about what applies.
	// A re-pointed node mints nothing, so it never reads "Edited".
	const edited =
		editable &&
		stage === "accept" &&
		draft !== undefined &&
		buildEditedFields(seed, draft) !== undefined;
	// The near-match affordance under the label (only on a non-rejected create node
	// that has near-matches): re-pointed → "Create new instead"; sent back to New
	// with a single near-match → "Use existing «…»"; 2+ → an advisory note.
	const showNearMatchAffordance =
		node.disposition === "create" && nearMatches.length > 0 && !rejected;

	if (editing) {
		// Seed the form from the committed draft (re-open) or the node's proposed
		// fields (first open). A non-create node is never editable, so the seed is
		// always present here; guard defensively all the same.
		const initial = draft ?? seedNodeDraft(node, seed);
		if (initial !== null) {
			return (
				<li
					data-graph-node={node.handle}
					data-node-stage={stage}
					data-node-editing="true"
					className="rounded-lg border border-border/60 px-3 py-2.5"
				>
					<GraphNodeEditForm
						node={node}
						initial={initial}
						disabled={disabled}
						onSave={onSave}
						onCancel={onCancel}
					/>
				</li>
			);
		}
	}

	return (
		<li
			data-graph-node={node.handle}
			data-node-stage={stage}
			data-node-edited={edited ? "true" : undefined}
			data-node-repoint={repointed ? repointId : undefined}
			className={`flex items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2 ${
				rejected ? "opacity-60" : ""
			}`}
		>
			<NodeGlyph
				className="size-4 shrink-0 text-muted-foreground"
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<p
					className={`truncate text-sm text-card-foreground ${
						rejected ? "line-through" : "font-medium"
					}`}
				>
					{shownLabel}
				</p>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
					<span
						className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium ${badge.className}`}
					>
						<BadgeGlyph className="size-3" aria-hidden />
						{edited ? "Edited" : badge.label}
					</span>
					{showNearMatchAffordance ? (
						repointed ? (
							// Re-pointed onto an existing entity (the default for a single
							// near-match): offer the escape back to minting a new one.
							<button
								type="button"
								disabled={disabled}
								onClick={onCreateNew}
								className="cursor-pointer text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
							>
								Create new instead
							</button>
						) : nearMatches.length === 1 ? (
							// A single near-match the user sent back to "New": offer to reuse it.
							<button
								type="button"
								disabled={disabled}
								onClick={onReuseExisting}
								className="cursor-pointer text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
							>
								Use existing «{nearMatches[0].label}»
							</button>
						) : (
							// 2+ near-matches: surfaced advisorily, no auto-pick (the picker, #181).
							<span className="text-[0.6875rem] text-muted-foreground">
								Matches existing: {nearMatches.map((m) => m.label).join(", ")}
							</span>
						)
					) : null}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{editable ? (
					<button
						type="button"
						disabled={disabled}
						title="Edit"
						onClick={onEdit}
						className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
					>
						<Pencil className="size-3.5" aria-hidden />
						<span className="sr-only">Edit {shownLabel}</span>
					</button>
				) : null}
				<button
					type="button"
					aria-pressed={stage === "accept"}
					disabled={disabled || !acceptable}
					title={
						acceptable ? "Accept" : "Needs disambiguation — cannot accept yet"
					}
					onClick={() => onStage("accept")}
					className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
				>
					<Check className="size-4" aria-hidden />
					<span className="sr-only">Accept {shownLabel}</span>
				</button>
				<button
					type="button"
					aria-pressed={stage === "reject"}
					disabled={disabled}
					title="Reject"
					onClick={() => onStage("reject")}
					className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-pressed:bg-secondary aria-pressed:text-secondary-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
				>
					<X className="size-4" aria-hidden />
					<span className="sr-only">Reject {shownLabel}</span>
				</button>
			</div>
		</li>
	);
}

/** The inline per-type edit form for a create node's `edited_fields` (ADR-0042),
 * reusing the single-entity card's Editor primitives. Surfaces only the recognition
 * fields — Todo: title/note; Person: name/aliases/note; Project: name/outcome/note.
 * No status (a recognized entity is active; status is not a recognition output) and
 * no defer/due.
 *
 * The form owns its WORKING draft (seeded from `initial`); Save commits it to the
 * card buffer (nothing is sent until the whole graph's Apply), Cancel discards it.
 * Save is gated on the required field (name/title) being non-empty — an empty
 * required field cannot be committed (Core rejects it). */
function GraphNodeEditForm({
	node,
	initial,
	disabled,
	onSave,
	onCancel,
}: {
	node: ResolvedNode;
	initial: GraphNodeDraft;
	disabled: boolean;
	onSave: (draft: GraphNodeDraft) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<GraphNodeDraft>(initial);
	const nameId = useId();
	const secondaryId = useId();
	const noteId = useId();
	const requiredEmpty = draftRequiredEmpty(draft);
	const kindLabel =
		node.type === "todo"
			? "Todo"
			: node.type === "person"
				? "Person"
				: "Project";

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!requiredEmpty) onSave(draft);
			}}
			className="flex flex-col gap-3"
		>
			<p className="text-xs font-medium text-muted-foreground">
				Edit {kindLabel}
			</p>
			{draft.type === "todo" ? (
				<>
					<EditorField label="Title" htmlFor={nameId}>
						<EditorInput
							id={nameId}
							autoFocus
							value={draft.title}
							onChange={(event) =>
								setDraft({ ...draft, title: event.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteId}>
						<EditorTextarea
							id={noteId}
							value={draft.note}
							onChange={(event) =>
								setDraft({ ...draft, note: event.target.value })
							}
						/>
					</EditorField>
				</>
			) : draft.type === "person" ? (
				<>
					<EditorField label="Name" htmlFor={nameId}>
						<EditorInput
							id={nameId}
							autoFocus
							value={draft.name}
							onChange={(event) =>
								setDraft({ ...draft, name: event.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Aliases" htmlFor={secondaryId}>
						<EditorInput
							id={secondaryId}
							value={draft.aliases}
							placeholder="Other names, comma-separated"
							onChange={(event) =>
								setDraft({ ...draft, aliases: event.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteId}>
						<EditorTextarea
							id={noteId}
							value={draft.note}
							onChange={(event) =>
								setDraft({ ...draft, note: event.target.value })
							}
						/>
					</EditorField>
				</>
			) : (
				<>
					<EditorField label="Name" htmlFor={nameId}>
						<EditorInput
							id={nameId}
							autoFocus
							value={draft.name}
							onChange={(event) =>
								setDraft({ ...draft, name: event.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Outcome" htmlFor={secondaryId}>
						<EditorTextarea
							id={secondaryId}
							value={draft.outcome}
							onChange={(event) =>
								setDraft({ ...draft, outcome: event.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteId}>
						<EditorTextarea
							id={noteId}
							value={draft.note}
							onChange={(event) =>
								setDraft({ ...draft, note: event.target.value })
							}
						/>
					</EditorField>
				</>
			)}
			<footer className="flex items-center gap-2">
				<button
					type="submit"
					disabled={disabled || requiredEmpty}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 font-medium text-secondary-foreground text-sm transition-colors hover:bg-secondary/80 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Check className="size-3.5" aria-hidden />
					Save
				</button>
				<button
					type="button"
					disabled={disabled}
					onClick={onCancel}
					className="inline-flex cursor-pointer items-center rounded-md px-3 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					Cancel
				</button>
			</footer>
		</form>
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

// --- renderBody strategies -------------------------------------------------
// One per PROPOSAL_VIEWS row family (journal create/update/delete share one,
// mode-gated). Each owns the full detail body — including the `border-t` divider
// the JSX fork used to wrap them in — and reads the opaque payload (and, for
// journal diffs, the review context) only through the defensive helpers above.

/** Kinds with no detail body (reference, fallback). */
function renderNoBody(): ReactNode {
	return null;
}

/**
 * Journal create/update/delete share one two-root diff, selected by `mode`:
 * create → proposed only; update → current (if present) + proposed; delete →
 * current (or an "unavailable" note when context is absent), no proposed.
 */
function renderJournalBody(
	{ payload, reviewContext }: ProposalBodyArgs,
	mode: "create" | "update" | "delete",
): ReactNode {
	const currentJournalEntry = reviewContext?.current_journal_entry;
	const showCurrent = mode === "update" || mode === "delete";
	const showProposed = mode === "create" || mode === "update";
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{showCurrent ? (
				currentJournalEntry ? (
					<EntrySection
						title="Current entry"
						occurredAt={textField(currentJournalEntry, "occurred_at")}
						endedAt={textField(currentJournalEntry, "ended_at")}
						bodyText={journalBody(currentJournalEntry)}
					/>
				) : mode === "delete" ? (
					<p className="text-muted-foreground text-sm">
						Current entry details unavailable.
					</p>
				) : null
			) : null}
			{showProposed ? (
				<EntrySection
					title="Proposed entry"
					occurredAt={textField(payload, "occurred_at")}
					endedAt={textField(payload, "ended_at")}
					bodyText={journalBody(payload)}
				/>
			) : null}
		</div>
	);
}

function renderPersonBody({ payload }: ProposalBodyArgs): ReactNode {
	const note = textField(payload, "note");
	const aliases = arrayField(payload, "aliases").filter(
		(a): a is string => typeof a === "string",
	);
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
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
		</div>
	);
}

function renderProjectBody({ payload }: ProposalBodyArgs): ReactNode {
	const outcome = textField(payload, "outcome");
	const status = textField(payload, "status");
	const note = textField(payload, "note");
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
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
		</div>
	);
}

function renderCreateTodoBody({ payload }: ProposalBodyArgs): ReactNode {
	const todo = objectField(payload, "todo");
	const note = textField(todo, "note");
	const status = textField(todo, "status");
	const projectId = textField(todo, "project_id");
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
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
		</div>
	);
}

function renderUpdateTodoBody({ payload }: ProposalBodyArgs): ReactNode {
	const todo = objectField(payload, "todo");
	const title = textField(todo, "title");
	const note = textField(todo, "note");
	const status = textField(todo, "status");
	const projectId = textField(todo, "project_id");
	const removeIds = arrayField(payload, "remove_person_ids").filter(
		(id): id is string => typeof id === "string",
	);
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
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
		</div>
	);
}
