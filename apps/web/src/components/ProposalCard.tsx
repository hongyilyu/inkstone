import type { JsonValue } from "@inkstone/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
	Check,
	CircleHelp,
	Loader2,
	Pencil,
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
import { asProjectStatus, PROJECT_STATUS_OPTIONS } from "@/lib/entityFields";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import { readTasksAtSourceLimit } from "@/lib/hooks/useTickTick";
import { libraryItemTitle } from "@/lib/libraryItems";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	overlayCreatePerson,
	overlayCreateProject,
	seedCreatePerson,
	seedCreateProject,
} from "@/lib/proposalEdit";
import { readString } from "@/lib/readPayload";
import {
	buildTickTickPayload,
	seedTickTickDraft,
	type TickTickEditDraft,
} from "@/lib/ticktickWrite";
import { useRuntime } from "@/runtime";
import { pollTickTickWriteOnce } from "@/store/bridge";
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
	type ProposalEditPolicy,
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
	const payload: JournalEntryPayload = {
		occurred_at: occurredAt.trim(),
		body: [{ type: "text", text: bodyText.trim() }],
	};
	const ended = endedAt.trim();
	if (ended) payload.ended_at = ended;
	return payload;
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
	// Non-journal cards carry no journal-style payload validation.
	const canApply = payloadIssue === null;
	// The TickTick write family (ticktick-writes W3). Staleness is DERIVED from
	// the pending read shape on EVERY render — a reload or second tab re-derives
	// it, never a connection-local flag — so a stale card warns with accept (and
	// edit — an edit IS an accept) disabled while reject stays enabled.
	const ticktickWrite = proposal.ticktick_write;
	const staleConnection =
		ticktickWrite?.state === "proposed" && ticktickWrite.stale_connection;
	// The bounded observe-poll for an `executing` entered from hydration or
	// replay (unconditional hook; a no-op for every other kind/state).
	const writeUnresolved = useTickTickWritePoll(proposal);

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
	// the SAME inFlight/lastAttempt/retry plumbing as the journal saveEdit.
	const saveStructuredEdit = (editedPayload: EditedPayload) => {
		if (inFlight !== null || proposal.status === "deciding") return;
		setInFlight("edit");
		setEditing(false);
		lastAttempt.current = { decision: "edit", editedPayload };
		onDecide("edit", editedPayload);
	};

	if (status === "accepted" || status === "rejected") {
		const accepted = status === "accepted";
		// A write-family accept renders its DURABLE write state — executing
		// (with the bounded poll driving it to the recorded outcome), created,
		// failed, unknown, or the past-deadline "still unresolved" with the
		// Resolve-now re-decide — never a generic accepted pill over a write
		// whose outcome is its own value (ticktick-writes W-A4).
		if (
			accepted &&
			ticktickWrite !== undefined &&
			ticktickWrite.state !== "proposed"
		) {
			return (
				<TickTickWriteOutcome
					proposal={proposal}
					write={ticktickWrite}
					unresolved={writeUnresolved}
					onResolveNow={() => onDecide("accept")}
				/>
			);
		}
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
				view.editPolicy === "person" || view.editPolicy === "project" ? (
					<EntityEditForm
						variant={view.editPolicy}
						payload={payload}
						submitting={submitting}
						onSave={saveStructuredEdit}
						onCancel={() => setEditing(false)}
					/>
				) : view.editPolicy === "ticktick" ? (
					<TickTickEditForm
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

					{staleConnection ? (
						// Derived from the durable fingerprint comparison on every read
						// (ticktick-writes W-A4): warns on FIRST render in any tab, after
						// any reload — accept and edit stay disabled below; reject works.
						<p
							role="alert"
							className="flex items-start gap-1.5 text-sm text-destructive"
						>
							<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							The TickTick connection changed since this was proposed — reject
							it and ask again.
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
								disabled={submitting || !canApply || staleConnection}
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
								// An edit IS an accept (its save decides), so the stale gate
								// covers it too; reject below stays enabled.
								disabled={submitting || staleConnection}
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

// --- Person/Project inline edit form ----------------------------------------

type EntityEditVariant = Extract<ProposalEditPolicy, "person" | "project">;

// The form draft is discriminated by Entity type so each render arm and setter
// is checked against the corresponding shape.
type EntityEditDraft =
	| { variant: "person"; draft: CreatePersonDraft }
	| { variant: "project"; draft: CreateProjectDraft };

// Seed the variant's draft from the proposed payload (once, on mount). The form
// renders only inside the card's `editing` branch, so each open is a fresh mount
// that re-seeds — that is the re-seed-per-open behavior.
function seedEntityEditDraft(
	variant: EntityEditVariant,
	payload: JsonValue,
): EntityEditDraft {
	switch (variant) {
		case "person":
			return { variant, draft: seedCreatePerson(payload) };
		case "project":
			return { variant, draft: seedCreateProject(payload) };
	}
}

// The variant's required-field gate (Save disabled when it returns true):
// person/project gate on a blank name.
function entityRequiredEmpty(state: EntityEditDraft): boolean {
	switch (state.variant) {
		case "person":
			return state.draft.name.trim() === "";
		case "project":
			return state.draft.name.trim() === "";
	}
}

// Run the variant's pure overlay against the proposed payload, producing the edited
// wire payload. person/project use the create overlay (the update overlays are pure
// delegations — identical output; the top-level entity_id rides untouched through the
// clone).
function overlayEntityEdit(
	state: EntityEditDraft,
	payload: JsonValue,
): EditedPayload {
	switch (state.variant) {
		case "person":
			return overlayCreatePerson(payload, state.draft);
		case "project":
			return overlayCreateProject(payload, state.draft);
	}
}

/**
 * The Person/Project inline editor owns its draft, surfaced fields, required-field
 * gate, and payload overlay. Its variant comes directly from the resolved
 * proposal-view policy.
 */
function EntityEditForm({
	variant,
	payload,
	submitting,
	onSave,
	onCancel,
}: {
	variant: EntityEditVariant;
	payload: JsonValue;
	submitting: boolean;
	onSave: (editedPayload: EditedPayload) => void;
	onCancel: () => void;
}): ReactNode {
	const noteInputId = useId();
	const statusInputId = useId();
	const nameInputId = useId();
	const aliasesInputId = useId();
	const outcomeInputId = useId();
	// Seed once from the proposed payload. `variant` is fixed for a card's view, and
	// the form re-mounts on each open, so this initializer is the re-seed.
	const [state, setState] = useState<EntityEditDraft>(() =>
		seedEntityEditDraft(variant, payload),
	);

	const requiredEmpty = entityRequiredEmpty(state);
	const submit = () => {
		if (submitting || requiredEmpty) return;
		onSave(overlayEntityEdit(state, payload));
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
			    (approval-gate legibility); the required field (Person/Project name)
			    autoFocuses on open (mirrors the journal form focusing its body —
			    autoFocus rides through EditorInput → Input onto the real <input>). */}
			{state.variant === "person" ? (
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
			) : (
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
										status: asProjectStatus(event.target.value),
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

// ─── the TickTick write family (ticktick-writes W3) ────────────────────────

/** Poll interval while observing an `executing` write, and the slack past the
 * wire's Core-computed `deadline_at` before the card stops polling and turns
 * honest ("still unresolved"). */
const TICKTICK_POLL_INTERVAL_MS = 1_500;
const TICKTICK_POLL_EPSILON_MS = 2_000;

/**
 * The bounded observe-poll (ticktick-writes W-A4): an `executing` write state
 * entered from hydration or replay drives itself to the recorded outcome by
 * polling `thread/get`, capped by the variant's Core-supplied `deadline_at`
 * (+ ε) — never a client-computed bound. The watchdog guarantees the server
 * settles by then, so the poll normally ends at the outcome with no user
 * action. Polling OBSERVES; it never settles server-side. Past the bound with
 * the read still executing, polling stops and the caller renders "still
 * unresolved" with the Resolve-now re-decide (a write — the past-bound belt).
 *
 * Unconditional hook: a no-op unless the record reads accepted + executing.
 */
function useTickTickWritePoll(proposal: PendingProposal): boolean {
	const runtime = useRuntime();
	const write = proposal.ticktick_write;
	const deadlineAt =
		proposal.status === "accepted" && write?.state === "executing"
			? write.deadline_at
			: null;
	const runId = proposal.run_id;
	const [unresolved, setUnresolved] = useState(false);

	useEffect(() => {
		if (deadlineAt === null) {
			setUnresolved(false);
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			if (stopped) {
				return;
			}
			if (Date.now() > deadlineAt + TICKTICK_POLL_EPSILON_MS) {
				// Watchdog residue: no outcome recorded by the deadline. Stop —
				// never an eternal creating… — and let the card offer Resolve now.
				setUnresolved(true);
				return;
			}
			const observed = await pollTickTickWriteOnce(runtime, runId);
			if (stopped || observed !== "executing") {
				return;
			}
			timer = setTimeout(() => void tick(), TICKTICK_POLL_INTERVAL_MS);
		};
		timer = setTimeout(() => void tick(), 0);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [deadlineAt, runId, runtime]);

	return unresolved;
}

/** The decided write-family card (W-A4): one row per durable write state —
 * states differ by glyph + label, never color alone. */
function TickTickWriteOutcome({
	proposal,
	write,
	unresolved,
	onResolveNow,
}: {
	proposal: PendingProposal;
	write: NonNullable<PendingProposal["ticktick_write"]>;
	unresolved: boolean;
	onResolveNow: () => void;
}) {
	const queryClient = useQueryClient();
	const shell =
		"inline-flex w-fit max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200";

	if (write.state === "executing") {
		if (unresolved) {
			return (
				<div
					data-proposal={proposal.run_id}
					data-proposal-status="accepted"
					data-ticktick-write="unresolved"
					className={shell}
				>
					<CircleHelp className="size-4 shrink-0" aria-hidden />
					<span aria-live="polite">
						Still unresolved — no outcome recorded; check TickTick before
						re-asking.
					</span>
					<Button
						type="button"
						variant="chip"
						size="pill"
						className="px-3"
						onClick={onResolveNow}
					>
						Resolve now
					</Button>
				</div>
			);
		}
		return (
			<div
				data-proposal={proposal.run_id}
				data-proposal-status="accepted"
				data-ticktick-write="executing"
				className={shell}
			>
				<Loader2
					className="size-4 shrink-0 motion-safe:animate-spin"
					aria-hidden
				/>
				<span aria-live="polite">Creating in TickTick…</span>
			</div>
		);
	}

	if (write.state === "created") {
		// The created task can exist yet fall outside the Tasks view's 200-item
		// page (W-A5): when the CURRENT cached Tasks read is at the source
		// limit, say so inline. Cache-only — a display hint, never a fetch.
		const atCap = readTasksAtSourceLimit(queryClient);
		return (
			<div
				data-proposal={proposal.run_id}
				data-proposal-status="accepted"
				data-ticktick-write="created"
				className={shell}
			>
				<Check className="size-4 shrink-0" aria-hidden />
				<span aria-live="polite">
					Created in TickTick
					{write.task_id ? ` (task ${write.task_id})` : ""}.
					{atCap
						? " May not appear in the Tasks view — TickTick returned its 200-item limit."
						: ""}
				</span>
			</div>
		);
	}

	if (write.state === "failed") {
		return (
			<div
				data-proposal={proposal.run_id}
				data-proposal-status="accepted"
				data-ticktick-write="failed"
				className={shell}
			>
				<X className="size-4 shrink-0 text-destructive" aria-hidden />
				<span aria-live="polite">
					Not created —{" "}
					{write.http_status !== undefined
						? `TickTick returned HTTP ${write.http_status}`
						: "the request could not be sent"}
					.
				</span>
			</div>
		);
	}

	// `unknown` (and, defensively, any novel state).
	return (
		<div
			data-proposal={proposal.run_id}
			data-proposal-status="accepted"
			data-ticktick-write="unknown"
			className={shell}
		>
			<CircleHelp className="size-4 shrink-0" aria-hidden />
			<span aria-live="polite">
				Outcome unknown — check TickTick before re-asking.
			</span>
		</div>
	);
}

/** The TickTick task edit form (W3): title, due date (+ optional time —
 * clearing the time sets all-day; the zone defaults to the payload's, else
 * the browser's), note. Submits the FULL effective payload as
 * `edited_payload` (replace semantics). */
function TickTickEditForm({
	payload,
	submitting,
	onSave,
	onCancel,
}: {
	payload: JsonValue;
	submitting: boolean;
	onSave: (editedPayload: EditedPayload) => void;
	onCancel: () => void;
}): ReactNode {
	const formId = useId();
	const titleInputId = `${formId}-ticktick-title`;
	const dateInputId = `${formId}-ticktick-date`;
	const timeInputId = `${formId}-ticktick-time`;
	const noteInputId = `${formId}-ticktick-note`;
	// Seed once from the proposed payload; the form re-mounts on each open.
	const [draft, setDraft] = useState<TickTickEditDraft>(() =>
		seedTickTickDraft(payload),
	);
	const built = buildTickTickPayload(draft);
	const issue = "issue" in built ? built.issue : null;

	const submit = () => {
		if (submitting || "issue" in built) {
			return;
		}
		onSave(built.payload);
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			className="flex flex-col gap-3 border-border border-t pt-3"
		>
			<EditorField label="Title" htmlFor={titleInputId}>
				<EditorInput
					id={titleInputId}
					autoFocus
					value={draft.title}
					onChange={(event) =>
						setDraft({ ...draft, title: event.target.value })
					}
				/>
			</EditorField>
			<EditorField label="Due date" htmlFor={dateInputId}>
				<EditorInput
					id={dateInputId}
					type="date"
					value={draft.date}
					onChange={(event) => setDraft({ ...draft, date: event.target.value })}
				/>
			</EditorField>
			<EditorField label="Time" htmlFor={timeInputId}>
				<EditorInput
					id={timeInputId}
					type="time"
					value={draft.time}
					placeholder="Leave empty for all-day"
					onChange={(event) => setDraft({ ...draft, time: event.target.value })}
				/>
			</EditorField>
			<EditorField label="Note" htmlFor={noteInputId}>
				<EditorTextarea
					id={noteInputId}
					value={draft.note}
					onChange={(event) => setDraft({ ...draft, note: event.target.value })}
				/>
			</EditorField>
			{issue !== null && draft.title.trim() !== "" ? (
				<p role="alert" className="text-sm text-destructive">
					Fix before saving: {issue}.
				</p>
			) : null}
			<EditFormFooter
				submitting={submitting}
				saveDisabled={issue !== null}
				onCancel={onCancel}
			/>
		</form>
	);
}
