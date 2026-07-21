import type { NodeDecision, ResolvedNode } from "@inkstone/protocol";
import { assertNever } from "@/lib/assertNever";
import { parseAliases } from "@/lib/entityFields";
import { readString, readStringArray } from "@/lib/readPayload";

/**
 * Pure staging logic for the `apply_intent_graph` sequential-review card
 * (ADR-0042). The whole graph is ONE Core Proposal, one park, one atomic apply;
 * "sequential" is purely client-side. The user walks the resolved plan node by
 * node, accumulating per-node accept/reject LOCALLY — nothing is written until
 * commit — then commits ONE `proposal/decide` carrying a `decisions[]` vector.
 *
 * This module owns the rules a card just renders: the per-node stage map, what a
 * plain Apply sweeps (an UNPICKED `ambiguous` node is reject-only until the user
 * picks one of its candidates — the disambiguation picker, #181 — which collapses it
 * to reuse-that-id), the per-node inline EDIT of a create node (the `edited_fields`
 * correction Core merges before minting), the decisions[] the commit sends (and the
 * summary the count/decision derive from), and the reconcile notice when rejecting a
 * node a surviving Todo links to.
 */

/** A node's staged choice in the local buffer (component state, not the store). */
export type NodeStage = "accept" | "reject";

/** The per-node staging buffer, keyed by graph handle. A handle with no entry is
 * "undecided" — the user has not stepped past it yet. Every buffer here is keyed by
 * `ResolvedNode.handle`, an unvalidated model-supplied wire string, so buffers are
 * `ReadonlyMap`s: `Map.get` returns `undefined` for a missing key by construction,
 * even one equal to an `Object.prototype` key ("toString", "__proto__"). */
export type StagingBuffer = ReadonlyMap<string, NodeStage>;

/** Whether a node's disposition permits `accept`. `create`/`reuse` are freely
 * acceptable. An `ambiguous` node has no silent fallback (ADR-0042), so it is
 * reject-only UNTIL the user picks one of its candidates: a pick is recorded as
 * that candidate's `entity_id` in the repoint buffer ({@link repointFor}), which
 * collapses the node `ambiguous → reuse` at decide. So an ambiguous node is
 * acceptable iff a candidate has been picked (#181 disambiguation picker).
 *
 * `repoints` defaults to an empty Map so a caller that only has a node (no pick
 * context) still reads the pre-pick truth: a create/reuse node is acceptable, an
 * ambiguous one is not. */
export function isAcceptable(
	node: ResolvedNode,
	repoints: RepointBuffer = new Map(),
): boolean {
	if (node.disposition !== "ambiguous") return true;
	return repointFor(repoints, node) !== null;
}

/** The per-handle re-point buffer (component state) for the near-match
 * default-to-existing affordance (ADR-0042 amendment). A handle maps to:
 *   - a string entity_id → re-point this create node onto that existing entity
 *     (the per-node `entity_id` override; collapses create → reuse at decide);
 *   - `null` → the user explicitly chose "Create new instead" (suppress the
 *     default re-point a single near-match would otherwise apply);
 *   - absent → no explicit choice; the default applies (see {@link repointFor}). */
export type RepointBuffer = ReadonlyMap<string, string | null>;

/** The effective re-point id for a node (ADR-0042 amendment), prioritizing the
 * existing entity: an explicit buffer entry wins (a string id re-points; `null`
 * means "create new instead" → no re-point). With no explicit entry, a `create`
 * node carrying EXACTLY ONE near-match defaults to that entity's id (the
 * default-to-existing behavior). Zero or 2+ near-matches → no default (2+ defer to
 * the disambiguation picker, #181). Returns `null` when there is no re-point. */
export function repointFor(
	buffer: RepointBuffer,
	node: ResolvedNode,
): string | null {
	// An explicit entry — a string id OR `null` ("create new instead") — wins;
	// `undefined` means absent, so fall through to the near-match default below.
	const explicit = buffer.get(node.handle);
	if (explicit !== undefined) return explicit;
	if (node.disposition !== "create") return null;
	const near = node.near_matches ?? [];
	return near.length === 1 ? near[0].entity_id : null;
}

/** The effective stage for a node — the ONE place the ambiguous accept-block is
 * enforced on reads, so rows, notices, and the decision vector can never drift. An
 * unacceptable node (an UNPICKED `ambiguous` one, ADR-0042) is always `reject`,
 * even if a stale buffer entry says accept. Otherwise its explicit entry wins, else
 * the default: every acceptable node defaults to `accept` (the common path is
 * accept-everything). A picked ambiguous node is acceptable — hence `repoints` is
 * consulted. */
export function stageFor(
	buffer: StagingBuffer,
	node: ResolvedNode,
	repoints: RepointBuffer = new Map(),
): NodeStage {
	if (!isAcceptable(node, repoints)) return "reject";
	return buffer.get(node.handle) ?? "accept";
}

/** Toggle one node's stage, respecting the ambiguous accept-block: a request to
 * `accept` an unacceptable node is ignored (it stays reject-only). A picked
 * ambiguous node IS acceptable, so its accept is honored — hence `repoints` is
 * consulted. Returns a NEW buffer (the caller holds it in component state). */
export function setStage(
	buffer: StagingBuffer,
	node: ResolvedNode,
	stage: NodeStage,
	repoints: RepointBuffer = new Map(),
): StagingBuffer {
	if (stage === "accept" && !isAcceptable(node, repoints)) {
		return buffer;
	}
	return new Map(buffer).set(node.handle, stage);
}

/** Stage EVERY node `reject` — the "Reject all" affordance. */
export function rejectAll(plan: readonly ResolvedNode[]): StagingBuffer {
	const next = new Map<string, NodeStage>();
	for (const node of plan) {
		next.set(node.handle, "reject");
	}
	return next;
}

/**
 * A per-node inline edit draft for a `create` node (ADR-0042 `edited_fields`): the
 * surfaced, correctable fields of a freshly-RECOGNIZED entity. A discriminated union
 * keyed by node type. Only the recognition surface is editable — there is no
 * `status` (a just-recognized entity is active; status is not a recognition output)
 * and no defer/due. Reuse/ambiguous nodes are never edited (Core rejects
 * `edited_fields` on a non-create node): a reused entity is linked-to, not rewritten.
 */
export type GraphNodeDraft =
	| { type: "person"; name: string; note: string; aliases: string }
	| { type: "project"; name: string; outcome: string; note: string }
	| { type: "todo"; title: string; note: string };

/** The per-handle draft buffer (component state), holding a draft for every create
 * node the user has opened for edit. A handle with no entry was never edited. */
export type DraftBuffer = ReadonlyMap<string, GraphNodeDraft>;

/** The whole client-side review state for one `apply_intent_graph` proposal: the
 * three per-node buffers that together decide what the commit sends. The card WRITES
 * only through dispatched intents ({@link reviewReducer}) and reads per-node facts
 * through {@link nodeView} — so the cross-buffer invariants (a pick sets repoint AND
 * accept; reuse-existing clears repoint+draft AND accepts) live in the reducer, in one
 * place, rather than scattered across card handlers. (The card still reads the buffers
 * for whole-plan derivations — the decision vector, downgrade notices — passing them to
 * the pure `buildDecisions`/`downgradeNotices` helpers unchanged.) */
export interface ReviewState {
	readonly stages: StagingBuffer;
	readonly repoints: RepointBuffer;
	readonly drafts: DraftBuffer;
}

/** The empty review state — every node sits at its per-node default (acceptable →
 * accept, unpicked ambiguous → reject), nothing edited and no EXPLICIT repoint
 * overrides (a single-near-match create node still defaults to reuse via
 * {@link repointFor} — the empty repoints map records only user departures from that
 * default). The reducer's `reset` returns this, and `useReducer` initializes with it. */
export const initialReviewState: ReviewState = {
	stages: new Map(),
	repoints: new Map(),
	drafts: new Map(),
};

/** A user intent against the review state. Each variant names what the user did, not
 * which buffers move — the reducer owns that mapping so a single action can enforce a
 * cross-buffer invariant atomically (e.g. `pick` sets the repoint AND the accept in
 * one transition, which is why the card needs no post-pick repoint hand-off). */
export type ReviewAction =
	| { type: "stage"; node: ResolvedNode; stage: NodeStage }
	| { type: "pick"; node: ResolvedNode; entityId: string }
	| { type: "createNewInstead"; handle: string }
	| { type: "reuseExisting"; node: ResolvedNode }
	| { type: "saveDraft"; node: ResolvedNode; draft: GraphNodeDraft }
	| { type: "rejectAll"; plan: readonly ResolvedNode[] }
	| { type: "reset" };

/** The one pure transition for the review state (ADR-0042). Never mutates `state` or
 * its Maps: a branch that changes a buffer builds a fresh Map for it (leaving the
 * untouched buffers shared by reference), so React sees a new `ReviewState` — except a
 * no-op (`stage` blocked by the accept-guard) returns `state` itself and `reset`
 * returns the shared `initialReviewState`, both intentional identity short-circuits.
 * Each branch owns its whole cross-buffer invariant:
 *
 *  - `stage` toggles one node, honoring the ambiguous accept-block ({@link setStage}
 *    ignores an accept on an unpicked ambiguous node — a no-op returns `state`);
 *  - `pick` records the candidate's `entity_id` as the node's repoint AND stages it
 *    accept in the SAME transition — the pick is visible to the accept, so there is no
 *    sibling-setState ordering hazard the card must dodge;
 *  - `createNewInstead` sets the repoint to `null` (suppress the near-match default);
 *  - `reuseExisting` clears the explicit repoint AND drops any edit draft AND stages
 *    accept (a reused entity is linked-to, not minted/edited — mutually exclusive);
 *  - `saveDraft` records the edit draft AND stages accept (an edit only applies to a
 *    node you keep);
 *  - `rejectAll` stages every node in the carried plan `reject`;
 *  - `reset` returns {@link initialReviewState} (a fresh proposal identity). */
export function reviewReducer(
	state: ReviewState,
	action: ReviewAction,
): ReviewState {
	switch (action.type) {
		case "stage": {
			const stages = setStage(
				state.stages,
				action.node,
				action.stage,
				state.repoints,
			);
			return stages === state.stages ? state : { ...state, stages };
		}
		case "pick": {
			const repoints = new Map(state.repoints).set(
				action.node.handle,
				action.entityId,
			);
			// Stage accept against the JUST-computed repoints, not `state.repoints`, so
			// the picked node reads as acceptable in the same transition.
			const stages = setStage(state.stages, action.node, "accept", repoints);
			return { ...state, stages, repoints };
		}
		case "createNewInstead": {
			const repoints = new Map(state.repoints).set(action.handle, null);
			return { ...state, repoints };
		}
		case "reuseExisting": {
			const repoints = new Map(state.repoints);
			repoints.delete(action.node.handle);
			const drafts = new Map(state.drafts);
			drafts.delete(action.node.handle);
			// Clear repoint+draft FIRST, then stage accept against the cleared repoints so
			// the single-near-match default re-applies (an ambiguous node is not reused
			// here — this affordance is for create nodes, which are always acceptable).
			const stages = setStage(state.stages, action.node, "accept", repoints);
			return { stages, repoints, drafts };
		}
		case "saveDraft": {
			const drafts = new Map(state.drafts).set(
				action.node.handle,
				action.draft,
			);
			const stages = setStage(
				state.stages,
				action.node,
				"accept",
				state.repoints,
			);
			return { ...state, stages, drafts };
		}
		case "rejectAll":
			return { ...state, stages: rejectAll(action.plan) };
		case "reset":
			return initialReviewState;
		default:
			return assertNever(action, "review action");
	}
}

/** The per-node facts a row renders, bundled into one read so the card consults the
 * state through a single selector instead of four raw buffer reads: the effective
 * `stage`, the RAW `explicitStage` (undefined when the node sits at its default —
 * distinguishes an unpicked ambiguous node from an explicitly rejected one), the
 * effective `repointId`, and the node's edit `draft`. */
export interface NodeView {
	readonly stage: NodeStage;
	readonly explicitStage: NodeStage | undefined;
	readonly repointId: string | null;
	readonly draft: GraphNodeDraft | undefined;
}

/** Project the four per-node facts a row needs out of the {@link ReviewState}
 * (ADR-0042): the effective `stage`, the RAW `explicitStage`, the effective
 * `repointId`, and the edit `draft`. Delegates to {@link stageFor}/{@link repointFor}
 * so the effective-stage rule lives in ONE place — the row and the decision vector
 * (via {@link buildDecisions}, which also calls `stageFor`) can never drift. */
export function nodeView(state: ReviewState, node: ResolvedNode): NodeView {
	return {
		stage: stageFor(state.stages, node, state.repoints),
		explicitStage: state.stages.get(node.handle),
		repointId: repointFor(state.repoints, node),
		draft: state.drafts.get(node.handle),
	};
}

/** Index the graph payload's `entities[]` by handle, so an edit can seed from — and
 * diff against — a node's ORIGINAL proposed fields. Degrades a malformed payload to
 * an empty map rather than throwing (the wire payload is unvalidated, ADR-0014). */
export function parseGraphEntities(
	payload: unknown,
): Map<string, Record<string, unknown>> {
	const out = new Map<string, Record<string, unknown>>();
	if (!payload || typeof payload !== "object") return out;
	const raw = (payload as Record<string, unknown>).entities;
	if (!Array.isArray(raw)) return out;
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const handle = (entry as Record<string, unknown>).handle;
		if (typeof handle === "string") {
			out.set(handle, entry as Record<string, unknown>);
		}
	}
	return out;
}

/** Seed an edit draft from a create node's ORIGINAL proposed fields (its matching
 * `entities[]` entry, looked up via {@link parseGraphEntities}). Returns `null` for a
 * node that is not a `create` (reuse/ambiguous are never edited) or whose entity is
 * missing from the payload. The surfaced fields differ by type — the recognition
 * surface only. */
export function seedNodeDraft(
	node: ResolvedNode,
	entity: Record<string, unknown> | undefined,
): GraphNodeDraft | null {
	if (node.disposition !== "create" || entity === undefined) return null;
	switch (node.type) {
		case "person":
			return {
				type: "person",
				name: readString(entity, "name"),
				note: readString(entity, "note"),
				aliases: readStringArray(entity, "aliases").join(", "),
			};
		case "project":
			return {
				type: "project",
				name: readString(entity, "name"),
				outcome: readString(entity, "outcome"),
				note: readString(entity, "note"),
			};
		case "todo":
			return {
				type: "todo",
				title: readString(entity, "title"),
				note: readString(entity, "note"),
			};
	}
}

/** A node's required field (Person/Project `name`, Todo `title`) — the one the Save
 * is gated on. Blank ⇒ Save disabled (Core would reject an empty required field;
 * the gate keeps it client-side too). */
export function draftRequiredEmpty(draft: GraphNodeDraft): boolean {
	const required = draft.type === "todo" ? draft.title : draft.name;
	return required.trim() === "";
}

/** The label to show on a node's COLLAPSED row: the edited name/title when a draft
 * has been opened (so the row reflects the correction), else the node's original
 * label. Falls back to the original when the edited required field is blank. */
export function draftLabel(node: ResolvedNode, draft: GraphNodeDraft): string {
	const edited = (draft.type === "todo" ? draft.title : draft.name).trim();
	return edited || node.label;
}

/** Diff one clearable optional string field: returns `undefined` when unchanged,
 * else the trimmed value, or `null` when the user blanked a field that had a value
 * (the ADR-0033 clear directive — Core's merge removes the key). */
function diffOptional(
	original: string,
	next: string,
): string | null | undefined {
	const o = original.trim();
	const n = next.trim();
	if (o === n) return undefined;
	return n === "" ? null : n;
}

/** Diff a required string field (name/title): the trimmed value when it changed to a
 * NON-empty value, else `undefined`. A blank required field is never emitted — it
 * cannot be cleared, and Save is gated on it. */
function diffRequired(original: string, next: string): string | undefined {
	const o = original.trim();
	const n = next.trim();
	return n !== "" && n !== o ? n : undefined;
}

/** Build the `edited_fields` correction for a create node: the minimal patch from
 * the node's ORIGINAL proposed fields to the draft (ADR-0042). A changed field is
 * set; a blanked clearable optional is `null` (Core removes the key); an unchanged
 * field is omitted. Returns `undefined` when nothing changed — the node then commits
 * as a plain accept (no `edited_fields`). Person/Project edit flat fields; a Todo's
 * fields target the inner `{todo}` envelope Core-side, but the wire `edited_fields`
 * is flat (Core merges into the right object by node type). */
export function buildEditedFields(
	original: Record<string, unknown> | undefined,
	draft: GraphNodeDraft,
): Record<string, unknown> | undefined {
	const source = original ?? {};
	const edits: Record<string, unknown> = {};
	const setOptional = (key: string, value: string | null | undefined) => {
		if (value !== undefined) edits[key] = value;
	};
	const setRequired = (key: string, value: string | undefined) => {
		if (value !== undefined) edits[key] = value;
	};

	switch (draft.type) {
		case "person": {
			setRequired("name", diffRequired(readString(source, "name"), draft.name));
			setOptional("note", diffOptional(readString(source, "note"), draft.note));
			const aliases = parseAliases(draft.aliases);
			const originalAliases = readStringArray(source, "aliases");
			if (!sameStrings(aliases, originalAliases)) {
				edits.aliases = aliases.length > 0 ? aliases : null;
			}
			break;
		}
		case "project": {
			setRequired("name", diffRequired(readString(source, "name"), draft.name));
			setOptional(
				"outcome",
				diffOptional(readString(source, "outcome"), draft.outcome),
			);
			setOptional("note", diffOptional(readString(source, "note"), draft.note));
			break;
		}
		case "todo": {
			setRequired(
				"title",
				diffRequired(readString(source, "title"), draft.title),
			);
			setOptional("note", diffOptional(readString(source, "note"), draft.note));
			break;
		}
	}
	return Object.keys(edits).length > 0 ? edits : undefined;
}

/** Whether two string arrays hold the same values in the same order. */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Build the per-node `decisions[]` vector the commit sends (ADR-0042): one entry
 * per plan node keyed by handle, each carrying its effective stage. A vector of
 * all-accepts is the safe/explicit "accept everything unchanged"; an all-reject
 * vector is the reject-all path.
 *
 * An ACCEPTED `create` node with an edit draft carries `edited_fields` — the minimal
 * correction from its proposed fields (omitted when the draft is unchanged, so an
 * opened-but-untouched form leaves a plain accept). A rejected node never carries an
 * edit (a rejected node is not minted); the draft survives in the buffer so
 * re-accepting restores it.
 *
 * An accepted create node with an effective near-match RE-POINT (ADR-0042
 * amendment — {@link repointFor}, default-to-existing) instead carries
 * `entity_id`: the existing entity it is re-pointed onto. `entity_id` and
 * `edited_fields` are mutually exclusive per node (Core rejects both — you reuse
 * what you re-point, you edit what you mint), so a re-point WINS over any edit
 * draft (the node is reused, not minted). */
export function buildDecisions(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
	drafts: DraftBuffer = new Map(),
	entities: Map<string, Record<string, unknown>> = new Map(),
	repoints: RepointBuffer = new Map(),
): NodeDecision[] {
	return plan.map((node) => {
		const decision = stageFor(buffer, node, repoints);
		if (decision === "accept") {
			const repoint = repointFor(repoints, node);
			// An accepted `ambiguous` node rides its picked candidate as the
			// `entity_id` override Core collapses ambiguous → reuse (#181). `stageFor`
			// only reads `accept` when the pick (a non-null repoint) is present.
			if (node.disposition === "ambiguous") {
				return repoint !== null
					? { handle: node.handle, decision, entity_id: repoint }
					: { handle: node.handle, decision: "reject" };
			}
			// A `create` node's near-match RE-POINT (ADR-0042 amendment) reuses an
			// existing entity by id, riding the same `entity_id` override and taking
			// precedence over an edit draft (mutually exclusive: reuse what you
			// re-point, edit what you mint).
			if (node.disposition === "create") {
				if (repoint !== null) {
					return { handle: node.handle, decision, entity_id: repoint };
				}
				const draft = drafts.get(node.handle);
				if (draft !== undefined) {
					const edited = buildEditedFields(entities.get(node.handle), draft);
					if (edited !== undefined) {
						return { handle: node.handle, decision, edited_fields: edited };
					}
				}
			}
		}
		return { handle: node.handle, decision };
	});
}

/** The commit summary derived from the BUILT decision vector — the single source of
 * truth for what Apply sends. `acceptedCount` counts `accept` decisions; `allRejected`
 * is true iff the vector has ≥1 node and every one is `reject`. (The
 * `ambiguous-without-pick → reject` coercion lives in `stageFor`, so a count taken
 * from either the vector or a direct `stageFor` pass agrees.) */
export interface DecisionSummary {
	readonly acceptedCount: number;
	readonly allRejected: boolean;
}

export function summarizeDecisions(
	decisions: readonly NodeDecision[],
): DecisionSummary {
	const acceptedCount = decisions.filter((d) => d.decision === "accept").length;
	return {
		acceptedCount,
		allRejected: decisions.length > 0 && acceptedCount === 0,
	};
}

/** A GUARANTEED-distinct disambiguator line for one ambiguous-node candidate in the
 * picker (#181). The candidates share an identical exact-name label (that is WHY the
 * node is ambiguous), so the label alone can't tell two apart. Prefer the resolved
 * library subtitle (person note / project outcome / todo due); but that can be absent
 * (cache still warming) or itself collide (two People with no note both read
 * "Person"), which would render visually identical radios the user could mis-pick. So
 * ALWAYS append a short, stable id fragment as a last-resort distinguisher: the
 * subtitle stays the human-meaningful line, the id suffix guarantees no two rows are
 * byte-identical. `subtitle` is the resolved `libraryItemSubtitle(item)` or null. */
export function candidateSubtitle(
	entityId: string,
	subtitle: string | null,
): string {
	const idTag = `#${entityId.slice(0, 8)}`;
	const trimmed = subtitle?.trim();
	return trimmed ? `${trimmed} · ${idTag}` : idTag;
}

/** A reconcile notice surfaced BEFORE commit (ADR-0042 "shows this downgrade
 * before Apply"): when a Todo is staged `accept` but a Project/Person it links to
 * is staged `reject`, the link drops and the Todo lands degraded. We derive the
 * dependency from the plan's link metadata — but `ResolvedNode` carries no links,
 * so the caller passes the parsed graph links. Each notice names the dependent
 * Todo and the dropped link target. */
export interface DowngradeNotice {
	/** The handle of the Todo that loses a link. */
	readonly todoHandle: string;
	/** The handle of the rejected target whose link drops. */
	readonly targetHandle: string;
	/** The Todo's label, for display. */
	readonly todoLabel: string;
	/** A human sentence describing the dropped link. */
	readonly message: string;
	/** A stable render key, unique per dropped (todo, target, kind) link — a Todo
	 * can lose more than one link, so `todoHandle` alone would collide. */
	readonly key: string;
}

/** One intended link between two graph handles, parsed from the proposal payload
 * (the same `links[]` Core stores). Only `todo_project`/`todo_person` matter for
 * the downgrade notice (a `journal_ref` to a rejected entity collapses to text,
 * not a Todo downgrade). A `journal_ref` may carry `appendText` — a model-proposed
 * clause Core will APPEND to the saved entry's prose (ADR-0042 #221); it is surfaced
 * on the card so the user reviews the new sentence before accepting it. */
export interface GraphLink {
	readonly kind: "todo_project" | "todo_person" | "journal_ref";
	readonly from: string;
	readonly to: string;
	/** A `journal_ref`'s `append_text`: the clause appended to the entry's prose. */
	readonly appendText?: string;
}

/** A model-proposed clause an accepted `journal_ref` will append to a saved Journal
 * Entry's prose (ADR-0042 #221), surfaced for review before Apply. */
export interface AppendedClause {
	/** The entity handle the appended clause links to (its chip). */
	readonly targetHandle: string;
	/** The clause text Core will append (the new prose the user is approving). */
	readonly text: string;
	/** A stable render key, unique per source link (Core appends one clause per
	 * `journal_ref`, so two links to the same entity with identical text are distinct
	 * rows). Derived here so the card never keys on a non-unique handle/text or a raw
	 * array index. */
	readonly key: string;
}

/** The appended-prose clauses the user is about to approve: one per accepted
 * `journal_ref` carrying `append_text` whose target is staged accept. The appended
 * sentence exists ONLY in this proposal (unlike `match_text`, which chips prose the
 * entry already shows), so the card must render it — the ADR-0042 #221 approval
 * contract is "the user sees the new sentence on the card before accepting." */
export function appendedClauses(
	plan: readonly ResolvedNode[],
	links: readonly GraphLink[],
	buffer: StagingBuffer,
	repoints: RepointBuffer = new Map(),
): AppendedClause[] {
	const byHandle = new Map(plan.map((node) => [node.handle, node]));
	const out: AppendedClause[] = [];
	// `linkIndex` is the link's position in the source array — a stable per-link id that
	// disambiguates two journal_refs to the same entity with identical append_text.
	links.forEach((link, linkIndex) => {
		if (link.kind !== "journal_ref" || link.appendText === undefined) return;
		const target = byHandle.get(link.to);
		if (target === undefined || stageFor(buffer, target, repoints) !== "accept")
			return;
		out.push({
			targetHandle: link.to,
			text: link.appendText,
			key: `${link.to}:${linkIndex}`,
		});
	});
	return out;
}

/** Compute the downgrade notices for the current staging (ADR-0042 reconcile): for
 * every `todo_project`/`todo_person` link whose `from` Todo is staged accept and
 * whose `to` target is staged reject, the link drops and the Todo lands standalone
 * — surfaced so the user sees the downgrade before Apply.
 *
 * `repoints` is consulted (like every other staging read) so a PICKED ambiguous
 * link target reads as `accept`, not its pre-pick `reject` default: a Todo linked to
 * a person/project node the user disambiguated keeps that link at apply, so it must
 * NOT surface a spurious "without its link" notice. */
export function downgradeNotices(
	plan: readonly ResolvedNode[],
	links: readonly GraphLink[],
	buffer: StagingBuffer,
	repoints: RepointBuffer = new Map(),
): DowngradeNotice[] {
	const byHandle = new Map(plan.map((node) => [node.handle, node]));
	const isAccepted = (handle: string): boolean => {
		const node = byHandle.get(handle);
		return node !== undefined && stageFor(buffer, node, repoints) === "accept";
	};
	const isRejected = (handle: string): boolean => {
		const node = byHandle.get(handle);
		return node !== undefined && stageFor(buffer, node, repoints) === "reject";
	};

	const notices: DowngradeNotice[] = [];
	for (const link of links) {
		if (link.kind === "journal_ref") continue;
		if (!isAccepted(link.from) || !isRejected(link.to)) continue;
		const todo = byHandle.get(link.from);
		const target = byHandle.get(link.to);
		if (todo === undefined || target === undefined) continue;
		const targetLabel = target.label || target.handle;
		const todoLabel = todo.label || todo.handle;
		notices.push({
			todoHandle: link.from,
			targetHandle: link.to,
			todoLabel,
			key: `${link.from}:${link.to}:${link.kind}`,
			message:
				link.kind === "todo_project"
					? `“${todoLabel}” will be created without its project link to “${targetLabel}”.`
					: `“${todoLabel}” will be created without its link to “${targetLabel}”.`,
		});
	}
	return notices;
}

/** Parse the `links[]` from an opaque `apply_intent_graph` payload, degrading any
 * malformed link rather than throwing (the wire payload is unvalidated, ADR-0014).
 * Only the three known kinds survive. */
export function parseGraphLinks(payload: unknown): GraphLink[] {
	if (!payload || typeof payload !== "object") return [];
	const raw = (payload as Record<string, unknown>).links;
	if (!Array.isArray(raw)) return [];
	const out: GraphLink[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const kind = record.kind;
		const from = record.from;
		const to = record.to;
		if (
			(kind === "todo_project" ||
				kind === "todo_person" ||
				kind === "journal_ref") &&
			typeof from === "string" &&
			typeof to === "string"
		) {
			const appendText = record.append_text;
			out.push({
				kind,
				from,
				to,
				...(kind === "journal_ref" && typeof appendText === "string"
					? { appendText }
					: {}),
			});
		}
	}
	return out;
}
