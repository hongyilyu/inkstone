import type { ResolvedNode } from "@inkstone/protocol";
import {
	Check,
	Loader2,
	type LucideIcon,
	Pencil,
	Plus,
	TriangleAlert,
	X,
} from "lucide-react";
import { useEffect, useId, useMemo, useReducer, useState } from "react";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	appendedClauses,
	buildDecisions,
	buildEditedFields,
	candidateSubtitle,
	downgradeNotices,
	draftLabel,
	draftRequiredEmpty,
	type GraphNodeDraft,
	initialReviewState,
	nodeView,
	parseGraphEntities,
	parseGraphLinks,
	reviewReducer,
	seedNodeDraft,
	summarizeDecisions,
} from "@/lib/intentGraphReview";
import {
	KIND_META,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemSubtitle,
	libraryItemTitle,
} from "@/lib/libraryItems";
import type { PendingProposal } from "@/store/chat";
import {
	EditorField,
	EditorInput,
	EditorTextarea,
} from "./library/EntityEditor.js";
import {
	DecidedLibraryLink,
	type DecideHandler,
	PROPOSAL_VIEWS,
} from "./proposalViews.js";
import { Badge, type BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

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
export function IntentGraphReviewCard({
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
	// The whole per-node review state (staging + repoints + edit drafts) behind ONE
	// reducer. It starts at the per-node defaults (acceptable → accept, unpicked
	// ambiguous → reject), so a plain Apply with no toggles accepts everything
	// resolvable — the common path. The card dispatches intents; the reducer owns the
	// cross-buffer invariants (see `reviewReducer`).
	const [review, dispatch] = useReducer(reviewReducer, initialReviewState);
	// `editingHandle` is the ONE row currently expanded (one open at a time) — UI focus,
	// not review state, so it stays local.
	const [editingHandle, setEditingHandle] = useState<string | null>(null);
	const [inFlight, setInFlight] = useState<"commit" | "reject" | null>(null);
	// Reset the per-node review when the proposal IDENTITY changes. The card is keyed
	// by run_id, not proposal_id, so a multi-step Run that parks a SECOND
	// `apply_intent_graph` proposal after a resume reuses this same mounted card with a
	// fresh proposal_id. The state is keyed by graph-local handles (ephemeral model
	// labels that collide across extractions), so without this reset a prior graph's
	// toggles could leak into the next and submit an unintended decision.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the proposal id.
	useEffect(() => {
		dispatch({ type: "reset" });
		setEditingHandle(null);
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

	const notices = downgradeNotices(plan, links, review.stages, review.repoints);
	// The clauses Core will APPEND to a saved entry's prose for accepted `journal_ref`s
	// carrying `append_text` (ADR-0042 #221). This new prose exists only in the proposal,
	// so the card MUST show it — the approval contract is the user reading the sentence
	// before accepting it. (A `match_text` ref chips prose the entry already shows, so it
	// needs no preview.)
	const appendClauses = appendedClauses(
		plan,
		links,
		review.stages,
		review.repoints,
	);
	// The decision vector is the SINGLE source of truth for what Apply sends — build
	// it once and derive the count + reject-all path from it (not a parallel `stageFor`
	// pass), so the "Apply N items" label and the scalar decision can never disagree
	// with the vector. `buildDecisions` is where the `ambiguous-without-pick → reject`
	// coercion lives, so a separate count could otherwise show "Apply 1" on an
	// all-reject vector.
	const decisions = buildDecisions(
		plan,
		review.stages,
		review.drafts,
		entities,
		review.repoints,
	);
	const { acceptedCount, allRejected: everythingRejected } =
		summarizeDecisions(decisions);
	// An ambiguous node is still UNRESOLVED while it has neither a pick (a repoint
	// id) nor an EXPLICIT reject — it sits at its reject-only default awaiting a
	// decision. This drives the dynamic guidance note; once every ambiguous node is
	// picked or explicitly rejected, the note disappears (no nag). The explicit-reject
	// check reads the RAW buffer entry via `nodeView` (not the effective `stage`, whose
	// default for an unpicked ambiguous node is already `reject`).
	const unresolvedAmbiguous = plan.some((node) => {
		const view = nodeView(review, node);
		return (
			node.disposition === "ambiguous" &&
			view.repointId === null &&
			view.explicitStage !== "reject"
		);
	});

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
		// Build the reject-all vector from the reducer's own transition so the sent
		// vector and the dispatched state can never diverge. A reject-all mints nothing,
		// so no edited_fields ride along.
		const rejected = reviewReducer(review, { type: "rejectAll", plan });
		setInFlight("reject");
		onDecide("reject", undefined, buildDecisions(plan, rejected.stages));
		dispatch({ type: "rejectAll", plan });
	};

	// Open one create node's inline edit form (one row at a time). The form holds its
	// own working draft; the review state gains an entry only on Save.
	const openEdit = (handle: string) => {
		if (submitting) return;
		setEditingHandle(handle);
	};
	// Save commits the working draft and forces the node ACCEPT (an edit only applies to
	// a node you keep, `saveDraft` owns that pairing), then collapses the row.
	const saveEdit = (node: ResolvedNode, draft: GraphNodeDraft) => {
		dispatch({ type: "saveDraft", node, draft });
		setEditingHandle(null);
	};
	// Cancel discards the working draft (the review state is untouched) and collapses.
	const cancelEdit = () => setEditingHandle(null);

	// Near-match re-point toggles (ADR-0042 amendment, default-to-existing). A
	// single-near-match create node defaults to reusing its existing entity; these
	// record the EXPLICIT departures from that default. "Create new instead" sets
	// `null` (suppress the default → a plain create); "Reuse existing" clears the
	// override (back to the default re-point) — and, in the reducer, discards any edit
	// draft, since a reused entity is linked-to, not minted/edited (mutually exclusive).
	// (Named `reuseExisting`, not `use*`, so it is not mistaken for a React hook.)
	const createNewInstead = (handle: string) => {
		if (submitting) return;
		dispatch({ type: "createNewInstead", handle });
	};
	const reuseExisting = (node: ResolvedNode) => {
		if (submitting) return;
		dispatch({ type: "reuseExisting", node });
	};

	// Pick one of an ambiguous node's candidates (the disambiguation picker, #181): the
	// `pick` transition records that candidate's `entity_id` as the node's re-point AND
	// stages it accept in ONE step — so the pick is visible to the accept guard and the
	// node collapses ambiguous → reuse with no sibling-update ordering hazard.
	const pickCandidate = (node: ResolvedNode, entityId: string) => {
		if (submitting) return;
		dispatch({ type: "pick", node, entityId });
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
				{plan.map((node) => {
					const view = nodeView(review, node);
					return (
						<GraphNodeRow
							key={node.handle}
							node={node}
							stage={view.stage}
							explicitStage={view.explicitStage}
							disabled={submitting}
							draft={view.draft}
							seed={entities.get(node.handle)}
							editing={editingHandle === node.handle}
							repointId={view.repointId}
							itemsById={itemsById}
							onStage={(stage) => dispatch({ type: "stage", node, stage })}
							onEdit={() => openEdit(node.handle)}
							onSave={(draft) => saveEdit(node, draft)}
							onCancel={cancelEdit}
							onCreateNew={() => createNewInstead(node.handle)}
							onReuseExisting={() => reuseExisting(node)}
							onPickCandidate={(entityId) => pickCandidate(node, entityId)}
						/>
					);
				})}
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
							key={notice.key}
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
							{/* When every node is rejected the commit IS a dismiss, so a
							    check glyph (implying "confirm/apply") contradicts the
							    "Dismiss" label; show an X instead. */}
							{everythingRejected ? (
								<X className="size-4" aria-hidden />
							) : (
								<Check className="size-4" aria-hidden />
							)}
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
	// Prefix with a mount-unique id: `node.handle` is a graph-local ephemeral label
	// that collides across extractions, so two co-mounted graph cards (one per parked
	// Run) sharing a handle would emit the same radio `name` and, by native HTML
	// same-name grouping, behave as ONE radio group across cards. `useId` scopes it.
	const groupId = useId();
	const groupName = `${groupId}-candidate-${node.handle}`;
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
