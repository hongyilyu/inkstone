import { Check, Loader2, Pencil, RotateCcw } from "lucide-react";
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
import { libraryItemTitle } from "@/lib/libraryItems";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	type GtdEditVariant,
	gtdEditVariant,
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
import { readString } from "@/lib/readPayload";
import type { PendingProposal } from "@/store/chat";
import { IntentGraphReviewCard } from "./IntentGraphReviewCard.js";
import {
	EditFormFooter,
	EditorField,
	EditorInput,
	EditorSelect,
	EditorTextarea,
} from "./library/EntityEditor.js";
import { ObservationEditForm } from "./ProposalCardObservations.js";
import { journalBody, journalBodyHasEntityRef } from "./proposalBody.js";
import {
	DecidedLibraryLink,
	type DecideHandler,
	type EditedPayload,
	proposalView,
} from "./proposalViews.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

function assertNever(value: never): never {
	throw new Error(`Unhandled proposal edit policy: ${value}`);
}

type JournalEntryPayload = {
	occurred_at: string;
	ended_at?: string;
	body: Array<
		{ type: "text"; text: string } | { type: "entity_ref"; ref_id?: string }
	>;
};

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
	// Resolve referenced entity ids (project_id, person_id) to names for the review
	// body via the warm library cache — the same cache the decided-card link and the
	// intent-graph candidate subtitles read. Avoids surfacing raw UUIDs a user can't
	// read. A cache miss falls back to a short id (see `nameFor`).
	const { data: libraryItems } = useLibraryItems();
	const nameFor = useMemo(() => {
		const byId = new Map<string, string>();
		for (const item of libraryItems ?? [])
			byId.set(item.id, libraryItemTitle(item));
		return (id: string) => byId.get(id) ?? null;
	}, [libraryItems]);
	const { status, payload, rationale, mutation_kind } = proposal;
	const proposalErrorMessage = proposal.error_message;
	const occurredAt = readString(payload, "occurred_at");
	const endedAt = readString(payload, "ended_at");
	const bodyText = journalBody(payload);
	const entityId = readString(payload, "entity_id");
	const currentJournalEntry = proposal.review_context?.current_journal_entry;
	const bodyHasEntityRef =
		journalBodyHasEntityRef(payload) ||
		journalBodyHasEntityRef(currentJournalEntry);
	// Retained for journal-payload validation only: `payloadIssue` (accept gate)
	// and `editIssue` (Save gate) read create/update to pick which validator runs.
	// The detail-body routing these once also drove now lives in `view.renderBody`.
	const isCreateProposal = mutation_kind === "create_journal_entry";
	const isUpdateProposal = mutation_kind === "update_journal_entry";
	// The single resolved presentation entry: header glyph, accept-button glyph,
	// summary, review/accepted/rejected copy, accept/reject labels (+ busy variants),
	// edit policy, and edit-ability all read from here instead of per-kind ternaries.
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
		// Non-journal editors seed themselves from `payload` on fresh mount. The
		// journal arm re-seeds its local fields here.
		if (view.editPolicy === "journal") {
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
				view.editPolicy === "gtd" ? (
					<GtdEditForm
						kind={mutation_kind}
						payload={payload}
						submitting={submitting}
						onSave={saveStructuredEdit}
						onCancel={() => setEditing(false)}
					/>
				) : view.editPolicy === "observation" ? (
					<ObservationEditForm
						payload={payload}
						submitting={submitting}
						onSave={saveStructuredEdit}
						onCancel={() => setEditing(false)}
					/>
				) : view.editPolicy === "journal" ? (
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
								Fix before saving: {editIssue}.
							</p>
						) : null}
						<EditFormFooter
							submitting={submitting}
							saveDisabled={editIssue !== null}
							onCancel={() => setEditing(false)}
						/>
					</form>
				) : view.editPolicy === "readonly" ? null : (
					assertNever(view.editPolicy)
				)
			) : (
				<>
					{view.renderBody({
						payload,
						reviewContext: proposal.review_context,
						nameFor,
					})}

					{rationale ? (
						<p className="text-sm leading-relaxed text-muted-foreground">
							{rationale}
						</p>
					) : null}

					{payloadIssue ? (
						// A payload issue reads the same whether or not the last attempt
						// errored, so check it FIRST and render the alert once (an
						// errored attempt on a still-invalid payload is still "fix it").
						<p role="alert" className="text-sm text-destructive">
							Fix before saving: {payloadIssue}.
						</p>
					) : isError ? (
						<p role="alert" className="text-sm text-destructive">
							{proposalErrorMessage || "Couldn't apply. Try again."}
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
 * this component plus the proposal-view edit policy.
 *
 * Precondition: the proposal-view edit policy only mounts this for a GTD kind; a
 * non-GTD kind still degrades to null rather than crashing.
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
			<EditFormFooter
				submitting={submitting}
				saveDisabled={requiredEmpty}
				onCancel={onCancel}
			/>
		</form>
	);
}

// --- Intent-graph sequential review card (ADR-0042) -------------------------
