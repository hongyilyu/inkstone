import type {
	NodeDecision,
	ProposalReviewContext,
	ResolvedNode,
} from "@inkstone/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ArrowUpRight,
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
	PROJECT_STATUS_OPTIONS,
	type ProjectStatus,
	TODO_STATUS_OPTIONS,
	type TodoStatus,
} from "@/lib/entityFields";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	appendedClauses,
	buildDecisions,
	buildEditedFields,
	candidateSubtitle,
	type DraftBuffer,
	downgradeNotices,
	draftLabel,
	draftRequiredEmpty,
	type GraphNodeDraft,
	getOwn,
	parseGraphEntities,
	parseGraphLinks,
	type RepointBuffer,
	rejectAll,
	repointFor,
	type StagingBuffer,
	seedNodeDraft,
	setStage,
	stageFor,
	summarizeDecisions,
} from "@/lib/intentGraphReview";
import {
	KIND_META,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemSubtitle,
	libraryItemTitle,
} from "@/lib/libraryItems";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	type GtdEditVariant,
	gtdEditVariant,
	isGtdEditKind,
	overlayCreatePerson,
	overlayCreateProject,
	overlayCreateTodo,
	overlayUpdateTodo,
	seedCreatePerson,
	seedCreateProject,
	seedCreateTodo,
	seedUpdateTodo,
	type UpdateTodoDraft,
} from "@/lib/proposalEdit";
import type { PendingProposal } from "@/store/chat";
import {
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
} from "./library/EntityEditor.js";
import { Badge, type BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

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
	| "apply_intent_graph"
	| "record_observations";

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

export const PROPOSAL_VIEWS: Record<ProposalKind, ProposalView> = {
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
		rejectedCopy: "Kept current Todo.",
		acceptLabel: "Update Todo",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Keep current Todo",
		rejectBusyLabel: "Keeping current Todo...",
		canEdit: () => true,
		renderBody: renderUpdateTodoBody,
	},
	update_person: {
		glyph: KIND_META.person.icon,
		acceptGlyph: KIND_META.person.icon,
		summary: (payload) => textField(payload, "name") || "Update Person",
		reviewCopy: "Inkstone wants to update a Person.",
		acceptedCopy: "Updated Person.",
		rejectedCopy: "Kept current Person.",
		acceptLabel: "Update Person",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Keep current Person",
		rejectBusyLabel: "Keeping current Person...",
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
		rejectedCopy: "Kept current Project.",
		acceptLabel: "Update Project",
		acceptBusyLabel: "Updating...",
		rejectLabel: "Keep current Project",
		rejectBusyLabel: "Keeping current Project...",
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
	record_observations: {
		glyph: Activity,
		acceptGlyph: Activity,
		summary: observationBatchSummary,
		reviewCopy: "Inkstone wants to record Observations.",
		acceptedCopy: "Recorded Observations.",
		rejectedCopy: "Dismissed.",
		acceptLabel: "Record Observations",
		acceptBusyLabel: "Recording...",
		rejectLabel: "Dismiss",
		rejectBusyLabel: "Dismissing...",
		canEdit: () => true,
		renderBody: renderObservationBody,
	},
};

// An unrecognized kind renders like a generic Journal-Entry create, echoing the
// raw kind into the review prompt. Unreachable for rendered rows above, but
// `mutation_kind` is a bare string on the wire
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

function unknownField(payload: unknown, key: string): unknown {
	if (payload && typeof payload === "object" && key in payload) {
		return (payload as Record<string, unknown>)[key];
	}
	return undefined;
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
 * Names the Entity an accepted Proposal created/updated and deep-links to it in the
 * Library (ADR-0044 amendment — the link IS the undo answer, no reversal verb).
 * Resolves `entityId` live from the warm library-items cache. Renders `null`
 * (degrading to the caller's generic decided copy, never worse than before) when
 * there is no `entityId`, or it is not (yet) in the cache (still loading / Core
 * unreachable / since-deleted). `withTitle` shows the entity's current name before
 * the link (the single-entity card); the graph card keeps its own "Applied." copy
 * and adds only the anchor link. Always mounted by the decided branch so its hooks
 * are unconditional.
 */
function DecidedLibraryLink({
	entityId,
	withTitle,
}: {
	entityId: string | undefined;
	withTitle: boolean;
}) {
	const navigate = useNavigate();
	const { data: items } = useLibraryItems();
	const item: LibraryItem | undefined =
		entityId === undefined ? undefined : items?.find((i) => i.id === entityId);
	if (item === undefined) {
		return null;
	}
	const open = () =>
		navigate({
			to: "/library/$kind",
			params: { kind: KIND_META[item.kind].slug },
			search: { id: item.id },
		});
	return (
		<>
			{withTitle ? (
				<span className="truncate font-medium text-card-foreground">
					{libraryItemTitle(item)}
				</span>
			) : null}
			<button
				type="button"
				onClick={open}
				className="flex shrink-0 items-center gap-1 text-primary transition-colors hover:text-primary/80 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				View in Library
				<ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
			</button>
		</>
	);
}

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
	// A GTD kind surfaces the deep GtdEditForm at the fork; everything else (journal
	// create/update) uses the inline journal form. `isGtdEditKind` (the slice-1
	// resolver) is the SINGLE editor-selector — the per-kind seed/gate/overlay/render
	// switch lives INSIDE GtdEditForm, not here.
	const isGtdEdit = isGtdEditKind(mutation_kind);
	const isObservationEdit = mutation_kind === "record_observations";
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
	const editIssue = isCreateProposal
		? journalPayloadIssue(editOccurredAt, editBody, editEndedAt)
		: isUpdateProposal
			? journalPayloadIssue(editOccurredAt, editBody, editEndedAt, entityId)
			: null;
	const openEdit = () => {
		if (!canEdit) return;
		// A GTD or Observation kind opens its own form, which seeds itself from
		// `payload` on its fresh mount. The journal arm re-seeds the journal form's
		// fields here.
		if (!isGtdEdit && !isObservationEdit) {
			setEditOccurredAt(occurredAt);
			setEditEndedAt(endedAt);
			setEditBody(bodyText);
		}
		setEditing(true);
	};
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
	// Structured edit forms hand back the finished wire payload. Commit it through
	// the SAME inFlight/lastAttempt/retry plumbing as the journal saveEdit — the
	// card learns nothing about the GTD per-kind shape.
	const saveStructuredEdit = (editedPayload: Record<string, unknown>) => {
		if (inFlight !== null || proposal.status === "deciding") return;
		setInFlight("edit");
		setEditing(false);
		lastAttempt.current = { decision: "edit", editedPayload };
		onDecide("edit", editedPayload);
	};

	if (status === "accepted" || status === "rejected") {
		const accepted = status === "accepted";
		// Settled inline in the turn timeline next to tool rows, so it wears the
		// ToolCallRow pill chrome (ADR-0045) rather than the bordered Card.
		return (
			<div
				data-proposal={proposal.run_id}
				data-proposal-status={status}
				className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200"
			>
				{accepted ? <Check className="size-4 shrink-0" aria-hidden /> : null}
				<span aria-live="polite">{accepted ? acceptedCopy : rejectedCopy}</span>
				{/* Name + deep-link the created/updated Entity (ADR-0044 amendment); a
				    reject created nothing, so only an accept gets the link. Degrades to
				    the copy above when the Entity is unresolvable. */}
				{accepted ? (
					<DecidedLibraryLink entityId={proposal.entity_id} withTitle />
				) : null}
			</div>
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
					<GtdEditForm
						kind={mutation_kind}
						payload={payload}
						submitting={submitting}
						onSave={saveStructuredEdit}
						onCancel={() => setEditing(false)}
					/>
				) : isObservationEdit ? (
					<ObservationEditForm
						payload={payload}
						submitting={submitting}
						onSave={saveStructuredEdit}
						onCancel={() => setEditing(false)}
					/>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							saveEdit();
						}}
						className="flex flex-col gap-3 border-border border-t pt-3"
					>
						<EditorField label="Occurred at" htmlFor={occurredAtInputId}>
							<EditorInput
								id={occurredAtInputId}
								value={editOccurredAt}
								placeholder="YYYY-MM-DDTHH:MM:SS"
								onChange={(event) => setEditOccurredAt(event.target.value)}
							/>
						</EditorField>
						<EditorField label="Ended at" htmlFor={endedAtInputId}>
							<EditorInput
								id={endedAtInputId}
								value={editEndedAt}
								placeholder="YYYY-MM-DDTHH:MM:SS (optional)"
								onChange={(event) => setEditEndedAt(event.target.value)}
							/>
						</EditorField>
						<EditorField label="Body" htmlFor={bodyInputId}>
							<EditorTextarea
								id={bodyInputId}
								autoFocus
								value={editBody}
								onChange={(event) => setEditBody(event.target.value)}
							/>
						</EditorField>
						{editIssue ? (
							<p role="alert" className="text-sm text-destructive">
								Edit required fields: {editIssue}.
							</p>
						) : null}
						<footer className="flex items-center gap-2 pt-1">
							<Button
								type="submit"
								variant="primary"
								size="row"
								className="gap-1.5 px-3.5 py-2"
								disabled={submitting || editIssue !== null}
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
								onClick={() => setEditing(false)}
							>
								Cancel
							</Button>
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
							<Button
								type="button"
								variant="primary"
								size="row"
								className="gap-1.5 px-3.5 py-2"
								// Gate retry on what it will re-send: reject always allowed; a stored edit on its payload; a plain accept on `canApply`. See docs/design/web-chat-ui.md.
								disabled={
									lastAttempt.current?.decision === "reject"
										? false
										: lastAttempt.current?.decision === "edit"
											? lastAttempt.current.editedPayload === undefined
											: !canApply
								}
								onClick={retry}
							>
								<RotateCcw className="size-4" aria-hidden />
								Try again
							</Button>
						) : (
							<Button
								type="button"
								variant="primary"
								size="row"
								className="gap-1.5 px-3.5 py-2"
								disabled={submitting || !canApply}
								onClick={() => decide("accept")}
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
							</Button>
						)}

						{canEdit ? (
							<Button
								type="button"
								variant="chip"
								size="pill"
								className="gap-1.5 px-3"
								disabled={submitting}
								onClick={openEdit}
							>
								<Pencil className="size-3.5" aria-hidden />
								Edit
							</Button>
						) : null}

						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="ml-auto py-1.5 text-sm"
							disabled={submitting}
							onClick={() => decide("reject")}
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
						</Button>
					</footer>
				</>
			)}
		</Card>
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
	return { value: parsed as Record<string, unknown>, error: null };
}

function ObservationEditForm({
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

// --- GTD inline edit form (the deep module) ---------------------------------

// The draft a GtdEditForm holds, discriminated by the slice-1 GTD edit variant so
// tsc type-checks each render arm and each setter against the right draft shape.
// The 6 GTD wire kinds collapse to these 4 variants (update_person/update_project
// share the create person/project variant — their seed/overlay are pure delegations).
type GtdDraft =
	| { variant: "todo_create"; draft: CreateTodoDraft }
	| { variant: "todo_update"; draft: UpdateTodoDraft }
	| { variant: "person"; draft: CreatePersonDraft }
	| { variant: "project"; draft: CreateProjectDraft };

// Seed the variant's draft from the proposed payload (once, on mount). The form
// renders only inside the card's `editing` branch, so each open is a fresh mount
// that re-seeds — that is the re-seed-per-open behavior.
function seedGtdDraft(variant: GtdEditVariant, payload: unknown): GtdDraft {
	switch (variant) {
		case "todo_create":
			return { variant, draft: seedCreateTodo(payload) };
		case "todo_update":
			return { variant, draft: seedUpdateTodo(payload) };
		case "person":
			return { variant, draft: seedCreatePerson(payload) };
		case "project":
			return { variant, draft: seedCreateProject(payload) };
	}
}

// The variant's required-field gate (Save disabled when it returns true). Todo-create
// gates on a blank title; person/project on a blank name; todo-update gates only when
// the partial proposed a title (blanking an existing title would be invalid; a partial
// with no title key has nothing to gate, so Save stays enabled).
function gtdRequiredEmpty(state: GtdDraft): boolean {
	switch (state.variant) {
		case "todo_create":
			return state.draft.title.trim() === "";
		case "person":
			return state.draft.name.trim() === "";
		case "project":
			return state.draft.name.trim() === "";
		case "todo_update":
			return state.draft.titlePresent && state.draft.title.trim() === "";
	}
}

// Run the variant's pure overlay against the proposed payload, producing the edited
// wire payload. person/project use the create overlay (the update overlays are pure
// delegations — identical output; the top-level entity_id rides untouched through the
// clone).
function gtdOverlay(
	state: GtdDraft,
	payload: unknown,
): Record<string, unknown> {
	switch (state.variant) {
		case "todo_create":
			return overlayCreateTodo(payload, state.draft);
		case "todo_update":
			return overlayUpdateTodo(payload, state.draft);
		case "person":
			return overlayCreatePerson(payload, state.draft);
		case "project":
			return overlayCreateProject(payload, state.draft);
	}
}

/**
 * The GTD inline edit form — the deep module. It OWNS the GTD edit end-to-end: it
 * resolves the variant from `kind` (the slice-1 `gtdEditVariant`, the SINGLE source),
 * holds the surfaced fields in ONE `useState` seeded from `payload` on mount, renders
 * exactly the fields the user can change (approval-gate legibility), gates Save on the
 * variant's required field, and on Save runs the variant's overlay against `payload`
 * and hands the finished wire payload back through `onSave`. The card learns only
 * `isGtdEditKind` (the editor-selector) + this component.
 *
 * Precondition: `isGtdEditKind(kind)` (the fork only mounts this for a GTD kind); a
 * non-GTD kind would resolve to a null variant and the form renders nothing.
 */
function GtdEditForm({
	kind,
	payload,
	submitting,
	onSave,
	onCancel,
}: {
	kind: string;
	payload: unknown;
	submitting: boolean;
	onSave: (editedPayload: Record<string, unknown>) => void;
	onCancel: () => void;
}): ReactNode {
	const variant = gtdEditVariant(kind);
	const titleInputId = useId();
	const noteInputId = useId();
	const statusInputId = useId();
	const nameInputId = useId();
	const aliasesInputId = useId();
	const outcomeInputId = useId();
	// Seed once from the proposed payload. `variant` is fixed for a card's kind, and
	// the form re-mounts on each open, so this initializer is the re-seed.
	const [state, setState] = useState<GtdDraft | null>(() =>
		variant === null ? null : seedGtdDraft(variant, payload),
	);
	// A non-GTD kind has no variant — render nothing (the fork guards this, but the
	// wire kind is a bare string, so degrade rather than crash).
	if (state === null) return null;

	const requiredEmpty = gtdRequiredEmpty(state);
	const submit = () => {
		if (submitting || requiredEmpty) return;
		onSave(gtdOverlay(state, payload));
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			className="flex flex-col gap-3 border-border border-t pt-3"
		>
			{/* Each variant surfaces exactly the fields the user can change
			    (approval-gate legibility); the required field (Todo title /
			    Person+Project name) autoFocuses on open (mirrors the journal form
			    focusing its body — autoFocus rides through EditorInput → Input onto the
			    real <input>). */}
			{state.variant === "todo_create" ? (
				<>
					<EditorField label="Title" htmlFor={titleInputId}>
						<EditorInput
							id={titleInputId}
							autoFocus
							value={state.draft.title}
							onChange={(event) =>
								setState({
									variant: "todo_create",
									draft: { ...state.draft, title: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteInputId}>
						<EditorTextarea
							id={noteInputId}
							value={state.draft.note}
							onChange={(event) =>
								setState({
									variant: "todo_create",
									draft: { ...state.draft, note: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Status" htmlFor={statusInputId}>
						<EditorSelect
							id={statusInputId}
							value={state.draft.status}
							onChange={(event) =>
								setState({
									variant: "todo_create",
									draft: {
										...state.draft,
										status: event.target.value as TodoStatus,
									},
								})
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
			) : state.variant === "person" ? (
				<>
					<EditorField label="Name" htmlFor={nameInputId}>
						<EditorInput
							id={nameInputId}
							autoFocus
							value={state.draft.name}
							onChange={(event) =>
								setState({
									variant: "person",
									draft: { ...state.draft, name: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteInputId}>
						<EditorTextarea
							id={noteInputId}
							value={state.draft.note}
							onChange={(event) =>
								setState({
									variant: "person",
									draft: { ...state.draft, note: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Aliases" htmlFor={aliasesInputId}>
						<EditorInput
							id={aliasesInputId}
							value={state.draft.aliases}
							placeholder="Other names, comma-separated"
							onChange={(event) =>
								setState({
									variant: "person",
									draft: { ...state.draft, aliases: event.target.value },
								})
							}
						/>
					</EditorField>
				</>
			) : state.variant === "project" ? (
				<>
					<EditorField label="Name" htmlFor={nameInputId}>
						<EditorInput
							id={nameInputId}
							autoFocus
							value={state.draft.name}
							onChange={(event) =>
								setState({
									variant: "project",
									draft: { ...state.draft, name: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Outcome" htmlFor={outcomeInputId}>
						<EditorTextarea
							id={outcomeInputId}
							value={state.draft.outcome}
							onChange={(event) =>
								setState({
									variant: "project",
									draft: { ...state.draft, outcome: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Note" htmlFor={noteInputId}>
						<EditorTextarea
							id={noteInputId}
							value={state.draft.note}
							onChange={(event) =>
								setState({
									variant: "project",
									draft: { ...state.draft, note: event.target.value },
								})
							}
						/>
					</EditorField>
					<EditorField label="Status" htmlFor={statusInputId}>
						<EditorSelect
							id={statusInputId}
							value={state.draft.status}
							onChange={(event) =>
								setState({
									variant: "project",
									draft: {
										...state.draft,
										status: event.target.value as ProjectStatus,
									},
								})
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
				/* todo_update — edits the proposed PARTIAL in place. Title shows only
				   when the partial proposed one; Status shows only when the partial
				   carried a status (surfacing a select would inject an unrequested field
				   into the partial). Note is always surfaced; autoFocus falls to Note when
				   the title field is absent. */
				<>
					{state.draft.titlePresent ? (
						<EditorField label="Title" htmlFor={titleInputId}>
							<EditorInput
								id={titleInputId}
								autoFocus
								value={state.draft.title}
								onChange={(event) =>
									setState({
										variant: "todo_update",
										draft: { ...state.draft, title: event.target.value },
									})
								}
							/>
						</EditorField>
					) : null}
					<EditorField label="Note" htmlFor={noteInputId}>
						<EditorTextarea
							id={noteInputId}
							autoFocus={!state.draft.titlePresent}
							value={state.draft.note}
							onChange={(event) =>
								setState({
									variant: "todo_update",
									draft: { ...state.draft, note: event.target.value },
								})
							}
						/>
					</EditorField>
					{state.draft.statusPresent ? (
						<EditorField label="Status" htmlFor={statusInputId}>
							<EditorSelect
								id={statusInputId}
								value={state.draft.status}
								onChange={(event) =>
									setState({
										variant: "todo_update",
										draft: {
											...state.draft,
											status: event.target.value as TodoStatus,
										},
									})
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
				<Button
					type="submit"
					variant="primary"
					size="row"
					className="gap-1.5 px-3.5 py-2"
					disabled={submitting || requiredEmpty}
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

// --- Intent-graph sequential review card (ADR-0042) -------------------------

const GRAPH_VIEW = PROPOSAL_VIEWS.apply_intent_graph;

/** Per-disposition badge copy + tone. Kinds differ by glyph + label, never colour
 * alone (PRODUCT.md a11y): each badge pairs a glyph with its word. `ambiguous`
 * wears the warning tone because it BLOCKS accept (no picker yet, #181). */
const DISPOSITION_BADGE: Record<
	ResolvedNode["disposition"],
	{ label: string; glyph: LucideIcon; variant: BadgeProps["variant"] }
> = {
	create: {
		label: "New",
		glyph: Plus,
		variant: "secondary",
	},
	reuse: {
		label: "Existing",
		glyph: Check,
		variant: "secondary",
	},
	ambiguous: {
		label: "Needs disambiguation",
		glyph: TriangleAlert,
		variant: "destructive",
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
	// An ambiguous node's candidates share an identical exact-name label (that is WHY
	// they are ambiguous), so the label alone cannot tell them apart. Resolve each
	// candidate id against the warm library cache to render a disambiguating subtitle
	// (person note / project outcome / todo due, via `libraryItemSubtitle`). Indexed
	// by id; a candidate missing from the cache simply has no subtitle (it stays
	// pickable by its label). Same cache the decided-card link already reads.
	const { data: libraryItems } = useLibraryItems();
	const itemsById = useMemo(() => {
		const map = new Map<string, LibraryItem>();
		for (const item of libraryItems ?? []) map.set(item.id, item);
		return map;
	}, [libraryItems]);
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
		// Settled inline in the turn timeline next to tool rows, so it wears the
		// ToolCallRow pill chrome (ADR-0045) rather than the bordered Card.
		return (
			<div
				data-proposal={proposal.run_id}
				data-proposal-status={status}
				data-proposal-kind="apply_intent_graph"
				className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200"
			>
				{accepted ? <Check className="size-4 shrink-0" aria-hidden /> : null}
				<span aria-live="polite">
					{accepted ? GRAPH_VIEW.acceptedCopy : GRAPH_VIEW.rejectedCopy}
				</span>
				{/* Deep-link the graph's anchor Entity (ADR-0044 amendment); keep the
				    "Applied." copy (the accepted-node count isn't carried on a rehydrated
				    decided graph). Degrades to the copy when the anchor is unresolvable. */}
				{accepted ? (
					<DecidedLibraryLink entityId={proposal.entity_id} withTitle={false} />
				) : null}
			</div>
		);
	}

	const deciding = status === "deciding";
	const submitting = deciding || inFlight !== null;
	const isError = status === "error";

	const notices = downgradeNotices(plan, links, buffer, repoints);
	// The clauses Core will APPEND to a saved entry's prose for accepted `journal_ref`s
	// carrying `append_text` (ADR-0042 #221). This new prose exists only in the proposal,
	// so the card MUST show it — the approval contract is the user reading the sentence
	// before accepting it. (A `match_text` ref chips prose the entry already shows, so it
	// needs no preview.)
	const appendClauses = appendedClauses(plan, links, buffer, repoints);
	// The decision vector is the SINGLE source of truth for what Apply sends — build
	// it once and derive the count + reject-all path from it (not a parallel `stageFor`
	// pass), so the "Apply N items" label and the scalar decision can never disagree
	// with the vector. `buildDecisions` is where the `ambiguous-without-pick → reject`
	// coercion lives, so a separate count could otherwise show "Apply 1" on an
	// all-reject vector.
	const decisions = buildDecisions(plan, buffer, drafts, entities, repoints);
	const { acceptedCount, allRejected: everythingRejected } =
		summarizeDecisions(decisions);
	// An ambiguous node is still UNRESOLVED while it has neither a pick (a repoint
	// id) nor an EXPLICIT reject — it sits at its reject-only default awaiting a
	// decision. This drives the dynamic guidance note; once every ambiguous node is
	// picked or explicitly rejected, the note disappears (no nag). The explicit-reject
	// check reads the RAW buffer entry via `getOwn` (not `stageFor`, whose default for
	// an unpicked ambiguous node is already `reject`) — `getOwn` guards the
	// model-supplied handle against a prototype-key collision (see `repointFor`).
	const unresolvedAmbiguous = plan.some(
		(node) =>
			node.disposition === "ambiguous" &&
			repointFor(repoints, node) === null &&
			getOwn(buffer, node.handle) !== "reject",
	);

	const commit = () => {
		if (submitting) return;
		// `decisions` (built above) is the exact vector sent, and `everythingRejected`
		// is derived from it via `summarizeDecisions`, so the scalar decision and the
		// per-node vector are guaranteed consistent. A vector that rejects every node is
		// a reject-all (Core declines the whole graph); otherwise it is an accept
		// carrying the per-node subset — each accepted create node folding in its
		// `edited_fields` correction, or its near-match/picked `entity_id` re-point.
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

	// Pick one of an ambiguous node's candidates (the disambiguation picker, #181):
	// record that candidate's `entity_id` as the node's re-point, which makes the node
	// acceptable (`isAcceptable` sees the pick) and rides the `entity_id` override Core
	// collapses ambiguous → reuse. The accept must be forced HERE — `setStage` consults
	// `isAcceptable(node, repoints)`, and the `repoints` state update is not yet visible
	// to a sibling `setBuffer`, so pass the post-pick repoint explicitly.
	const pickCandidate = (node: ResolvedNode, entityId: string) => {
		if (submitting) return;
		setRepoints((current) => ({ ...current, [node.handle]: entityId }));
		setBuffer((current) =>
			setStage(current, node, "accept", { [node.handle]: entityId }),
		);
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
						stage={stageFor(buffer, node, repoints)}
						explicitStage={getOwn(buffer, node.handle)}
						disabled={submitting}
						draft={getOwn(drafts, node.handle)}
						seed={entities.get(node.handle)}
						editing={editingHandle === node.handle}
						repointId={repointFor(repoints, node)}
						itemsById={itemsById}
						onStage={(stage) =>
							setBuffer((current) => setStage(current, node, stage, repoints))
						}
						onEdit={() => openEdit(node.handle)}
						onSave={(draft) => saveEdit(node, draft)}
						onCancel={cancelEdit}
						onCreateNew={() => createNewInstead(node.handle)}
						onReuseExisting={() => reuseExisting(node)}
						onPickCandidate={(entityId) => pickCandidate(node, entityId)}
					/>
				))}
			</ul>

			{unresolvedAmbiguous ? (
				<p className="text-xs text-muted-foreground">
					Some items match more than one existing entry — pick which to reuse,
					or reject them.
				</p>
			) : null}

			{appendClauses.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<p className="text-xs font-medium text-muted-foreground">
						Will add to the entry:
					</p>
					<ul className="flex flex-col gap-1">
						{appendClauses.map((clause) => (
							<li
								// `clause.key` is unique per source link (two journal_refs to one
								// entity with identical text are still distinct rows), so the key
								// never collides — unlike handle or handle:text alone.
								key={clause.key}
								className="border-border/60 border-l-2 pl-2.5 text-sm leading-relaxed text-foreground"
							>
								{clause.text}
							</li>
						))}
					</ul>
				</div>
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
				<Button
					type="button"
					variant="primary"
					size="row"
					className="gap-1.5 px-3.5 py-2"
					disabled={submitting || plan.length === 0}
					onClick={commit}
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
				</Button>

				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto py-1.5 text-sm"
					disabled={submitting}
					onClick={rejectEverything}
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
				</Button>
			</footer>
		</Card>
	);
}

/** One node row in the intent-graph review queue: the entity glyph + label, a
 * create/reuse/ambiguous badge, and accept/reject toggles. A `create` node also
 * carries a pencil that expands the row INLINE into its per-type edit form (the
 * `edited_fields` correction); reuse/ambiguous nodes are not editable (Core rejects
 * an edit on a non-create node). When a draft is open the collapsed label reflects
 * the edited name/title.
 *
 * Re-point — both shapes share the `repointId` → "Existing «…»" badge + reuse path:
 *  - Near-match (ADR-0042 amendment): a `create` node re-pointed onto an existing
 *    entity (the default for a single near-match) wears the badge and a "Create new
 *    instead" escape, and is NOT editable. A create node sent back to "New" with a
 *    single near-match offers "Use existing «…»".
 *  - Ambiguous picker (#181): an `ambiguous` node renders its `candidates` as an
 *    inline radio list; an UNPICKED ambiguous node is reject-only (accept disabled),
 *    and picking a candidate sets `repointId` → the node becomes acceptable and reads
 *    "Existing «…»" (it reuses the picked entity). */
function GraphNodeRow({
	node,
	stage,
	explicitStage,
	disabled,
	draft,
	seed,
	editing,
	repointId,
	itemsById,
	onStage,
	onEdit,
	onSave,
	onCancel,
	onCreateNew,
	onReuseExisting,
	onPickCandidate,
}: {
	node: ResolvedNode;
	stage: "accept" | "reject";
	/** The node's RAW staging-buffer entry, or `undefined` if it sits at its default.
	 * Distinguishes an UNPICKED ambiguous node (default `reject`, awaiting a pick — it
	 * is pending, not dismissed) from one the user EXPLICITLY rejected. */
	explicitStage: "accept" | "reject" | undefined;
	disabled: boolean;
	draft: GraphNodeDraft | undefined;
	seed: Record<string, unknown> | undefined;
	editing: boolean;
	repointId: string | null;
	itemsById: Map<string, LibraryItem>;
	onStage: (stage: "accept" | "reject") => void;
	onEdit: () => void;
	onSave: (draft: GraphNodeDraft) => void;
	onCancel: () => void;
	onCreateNew: () => void;
	onReuseExisting: () => void;
	onPickCandidate: (entityId: string) => void;
}) {
	const NodeGlyph = KIND_META[node.type as LibraryItemKind].icon;
	// An UNPICKED ambiguous node sits at the `reject` DEFAULT but is pending a pick,
	// not dismissed — it should not read as rejected (no line-through/opacity) and must
	// still show its picker. A node reads "rejected" only when it is explicitly rejected
	// OR is a non-ambiguous node at the reject stage.
	const pendingPick =
		node.disposition === "ambiguous" &&
		repointId === null &&
		explicitStage !== "reject";
	const rejected = stage === "reject" && !pendingPick;
	const nearMatches = node.near_matches ?? [];
	const candidates = node.candidates ?? [];
	// A node is re-pointed onto an existing entity when `repointId` resolves — a
	// `create` node's single-near-match default, or an `ambiguous` node's picked
	// candidate (#181). Both collapse to reuse-that-entity. The badge label prefers
	// the matching candidate/near-match label, then the library cache, then "existing".
	const repointed =
		(node.disposition === "create" || node.disposition === "ambiguous") &&
		repointId !== null;
	const repointTarget =
		repointId !== null ? itemsById.get(repointId) : undefined;
	const repointLabel = repointed
		? (nearMatches.find((m) => m.entity_id === repointId)?.label ??
			candidates.find((c) => c.entity_id === repointId)?.label ??
			(repointTarget ? libraryItemTitle(repointTarget) : undefined) ??
			"existing")
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
				variant: DISPOSITION_BADGE.reuse.variant,
			}
		: DISPOSITION_BADGE[node.disposition];
	const BadgeGlyph = badge.glyph;
	// An ambiguous node is acceptable only once a candidate is picked (`repointId`
	// resolves); create/reuse are always acceptable. Mirrors `isAcceptable`, derived
	// from the already-resolved `repointId` so the row needs no repoint buffer.
	const acceptable = node.disposition !== "ambiguous" || repointId !== null;
	// An ambiguous node ALWAYS shows its candidate picker (while pending OR after an
	// explicit reject): the reject toggle is the "none of these" escape, and picking a
	// candidate re-accepts the node — so the radios must stay reachable to undo a
	// reject. Distinct from the near-match affordance, which is for create nodes.
	const showCandidatePicker =
		node.disposition === "ambiguous" && candidates.length > 0;
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
			className={`flex flex-col gap-2 rounded-lg border border-border/60 px-3 py-2 ${
				rejected ? "opacity-60" : ""
			}`}
		>
			<div className="flex items-center gap-2.5">
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
						<Badge variant={badge.variant} size="xs">
							<BadgeGlyph className="size-3" aria-hidden />
							{edited ? "Edited" : badge.label}
						</Badge>
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
						// `rejected`, not `stage === "reject"`: a PENDING ambiguous node sits at
						// the reject default but is awaiting a pick, not dismissed — its Reject
						// toggle must read "off" (un-pressed) so it doesn't look pre-rejected.
						aria-pressed={rejected}
						disabled={disabled}
						title="Reject"
						onClick={() => onStage("reject")}
						className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-pressed:bg-secondary aria-pressed:text-secondary-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
					>
						<X className="size-4" aria-hidden />
						<span className="sr-only">Reject {shownLabel}</span>
					</button>
				</div>
			</div>

			{showCandidatePicker ? (
				<GraphCandidatePicker
					node={node}
					candidates={candidates}
					pickedId={repointId}
					itemsById={itemsById}
					disabled={disabled}
					onPick={onPickCandidate}
				/>
			) : null}
		</li>
	);
}

/** The inline candidate picker for an `ambiguous` node (the disambiguation picker,
 * #181): a radio list of the node's competing exact-name matches. Their labels are
 * identical (that is why the node is ambiguous), so each row carries a disambiguating
 * subtitle resolved from the warm library cache (`libraryItemSubtitle` — person note /
 * project outcome / todo due). NO candidate is pre-selected: the matches are equal and
 * the system has no ranking signal, so an explicit pick is forced. Picking writes the
 * candidate's `entity_id` as the node's re-point, collapsing ambiguous → reuse. The
 * fieldset is the radio group; "none of these" is the row's Reject toggle, not a row. */
function GraphCandidatePicker({
	node,
	candidates,
	pickedId,
	itemsById,
	disabled,
	onPick,
}: {
	node: ResolvedNode;
	candidates: readonly { entity_id: string; label: string }[];
	pickedId: string | null;
	itemsById: Map<string, LibraryItem>;
	disabled: boolean;
	onPick: (entityId: string) => void;
}) {
	const groupName = `candidate-${node.handle}`;
	return (
		<fieldset
			className="flex flex-col gap-1 border-0 p-0"
			aria-label={`Pick which existing entry “${node.label}” reuses`}
		>
			{candidates.map((candidate) => {
				const item = itemsById.get(candidate.entity_id);
				// ALWAYS render a distinguishing line: the human-meaningful library
				// subtitle when resolved, plus a short stable id fragment so two
				// same-named candidates whose subtitles are absent (cache warming) or
				// identical ("Person"/"Person") never render as byte-identical radios.
				const subtitle = candidateSubtitle(
					candidate.entity_id,
					item ? libraryItemSubtitle(item) : null,
				);
				const picked = candidate.entity_id === pickedId;
				return (
					<label
						key={candidate.entity_id}
						data-candidate={candidate.entity_id}
						data-candidate-picked={picked ? "true" : undefined}
						className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
							picked
								? "border-primary/40 bg-primary/5"
								: "border-border/50 hover:bg-accent/50"
						} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
					>
						<input
							type="radio"
							name={groupName}
							value={candidate.entity_id}
							checked={picked}
							disabled={disabled}
							onChange={() => onPick(candidate.entity_id)}
							className="mt-0.5 size-3.5 shrink-0 accent-primary"
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm text-card-foreground">
								{candidate.label}
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{subtitle}
							</span>
						</span>
					</label>
				);
			})}
		</fieldset>
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

function observationValueText(value: unknown): string {
	if (value === undefined) return "Unknown";
	return JSON.stringify(value) ?? "Unknown";
}

function observationBatchSummary(payload: unknown): string {
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

function renderObservationBody({ payload }: ProposalBodyArgs): ReactNode {
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
									<Field
										label="Schema"
										value={
											observations.length === 1
												? schemaKey
												: `${position + 1}. ${schemaKey}`
										}
									/>
									<Field label="Occurred" value={occurredAt || "Unknown"} />
									{endedAt ? <Field label="Ended" value={endedAt} /> : null}
									<Field label="Values" value={values} />
									{note ? <Field label="Note" value={note} /> : null}
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
						<Field label="Source" value={evidence} />
					</dl>
				</section>
			) : null}
		</div>
	);
}

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

// One labelled `<section>` of Person `<Field>` rows, read defensively off an
// opaque body (a proposed payload OR the current entity from review_context). The
// update card stacks two of these (Current + Proposed) so a field present in the
// current body but omitted from the full-document replace stays visible (ADR-0016).
function personSection(title: string, body: unknown): ReactNode {
	const note = textField(body, "note");
	const aliases = arrayField(body, "aliases").filter(
		(a): a is string => typeof a === "string",
	);
	return (
		<section className="flex flex-col gap-2">
			<p className="text-xs font-medium tracking-normal text-muted-foreground">
				{title}
			</p>
			<dl className="flex flex-col gap-1.5 text-sm">
				<Field label="Name" value={textField(body, "name") || "Unknown"} />
				{note ? <Field label="Note" value={note} /> : null}
				{aliases.length > 0 ? (
					<Field label="Aliases" value={aliases.join(", ")} />
				) : null}
			</dl>
		</section>
	);
}

function renderPersonBody({
	payload,
	reviewContext,
}: ProposalBodyArgs): ReactNode {
	const currentPerson = reviewContext?.current_person;
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{currentPerson ? (
				<>
					{personSection("Current", currentPerson)}
					{personSection("Replacing with", payload)}
				</>
			) : (
				personSection("Person", payload)
			)}
		</div>
	);
}

// One labelled `<section>` of Project `<Field>` rows (sibling of personSection).
function projectSection(title: string, body: unknown): ReactNode {
	const outcome = textField(body, "outcome");
	const status = textField(body, "status");
	const note = textField(body, "note");
	return (
		<section className="flex flex-col gap-2">
			<p className="text-xs font-medium tracking-normal text-muted-foreground">
				{title}
			</p>
			<dl className="flex flex-col gap-1.5 text-sm">
				<Field label="Name" value={textField(body, "name") || "Unknown"} />
				{outcome ? <Field label="Outcome" value={outcome} /> : null}
				{status ? <Field label="Status" value={status} /> : null}
				{note ? <Field label="Note" value={note} /> : null}
			</dl>
		</section>
	);
}

function renderProjectBody({
	payload,
	reviewContext,
}: ProposalBodyArgs): ReactNode {
	const currentProject = reviewContext?.current_project;
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{currentProject ? (
				<>
					{projectSection("Current", currentProject)}
					{projectSection("Replacing with", payload)}
				</>
			) : (
				projectSection("Project", payload)
			)}
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
					{/* The raw `todo_id` UUID was surfaced here — unreadable to a user
					    and redundant with the card's "Update Todo" heading. Show only
					    the fields that actually change. */}
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
