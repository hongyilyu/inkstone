import type { NodeDecision } from "@inkstone/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ArrowUpRight,
	CalendarDays,
	Check,
	GitBranch,
	type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	KIND_META,
	type LibraryItem,
	libraryItemTitle,
} from "@/lib/libraryItems";
import {
	observationBatchSummary,
	renderObservationBody,
} from "./ProposalCardObservations.js";
import {
	journalBody,
	type ProposalBodyArgs,
	renderCreateTodoBody,
	renderJournalBody,
	renderNoBody,
	renderPersonBody,
	renderProjectBody,
	renderUpdateTodoBody,
} from "./proposalBody.js";
import { objectField, textField } from "./proposalPayload.js";

// The mutation kinds the Worker proposes (ADR-0025). Media and direct
// entity-edits are user-CRUD-only (ADR-0033/0059) — never proposed — so the card
// has never rendered them; an unrecognized kind degrades through `fallbackView`.
export type ProposalKind =
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

export type ProposalEditPolicy = "journal" | "gtd" | "observation" | "readonly";

// Per-kind presentation for a Proposal — the review card's analogue of KIND_META
// (lib/libraryItems): one entry concentrates the copy, labels, glyph,
// edit-ability, and detail-body render that distinguish one proposal kind from
// another, so a new kind is one new row instead of a fork threaded through a dozen
// ternaries. Glyphs reuse the canonical entity iconography (KIND_META) so a Person
// proposal wears the same mark it has in the Library, palette, and detail panels;
// kinds differ by glyph + label, never colour alone (PRODUCT.md a11y).
export interface ProposalView {
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
	/** Which editor owns this kind when `canEdit` allows the Edit affordance. */
	editPolicy: ProposalEditPolicy;
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
		editPolicy: "journal",
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
		editPolicy: "journal",
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
		editPolicy: "readonly",
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
		editPolicy: "readonly",
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
		editPolicy: "gtd",
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
		editPolicy: "gtd",
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
		editPolicy: "gtd",
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
		editPolicy: "gtd",
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
		editPolicy: "gtd",
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
		editPolicy: "gtd",
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
		editPolicy: "readonly",
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
		editPolicy: "observation",
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
		editPolicy: "readonly",
		renderBody: renderNoBody,
	};
}

export function proposalView(mutationKind: string): ProposalView {
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

export type EditedPayload = Record<string, unknown>;

export type DecideHandler = (
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
export function DecidedLibraryLink({
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
