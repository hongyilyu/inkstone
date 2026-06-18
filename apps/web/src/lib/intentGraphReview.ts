import type { NodeDecision, ResolvedNode } from "@inkstone/protocol";

/**
 * Pure staging logic for the `apply_intent_graph` sequential-review card
 * (ADR-0042). The whole graph is ONE Core Proposal, one park, one atomic apply;
 * "sequential" is purely client-side. The user walks the resolved plan node by
 * node, accumulating per-node accept/reject LOCALLY — nothing is written until
 * commit — then commits ONE `proposal/decide` carrying a `decisions[]` vector.
 *
 * This module owns the rules a card just renders: the per-node stage map, what
 * "accept all" can sweep (an `ambiguous` node has no picker yet — #181 — so it
 * BLOCKS accept-all and is reject-only), the decisions[] the commit sends, and the
 * reconcile notice when rejecting a node a surviving Todo links to.
 */

/** A node's staged choice in the local buffer (component state, not the store). */
export type NodeStage = "accept" | "reject";

/** The per-node staging buffer, keyed by graph handle. A handle with no entry is
 * "undecided" — the user has not stepped past it yet. */
export type StagingBuffer = Readonly<Record<string, NodeStage>>;

/** Whether a node's disposition forbids `accept` until the picker ships (#181):
 * an `ambiguous` node has no silent fallback and cannot be linked, so it is
 * reject-only (ADR-0042). `create`/`reuse` are freely acceptable. */
export function isAcceptable(node: ResolvedNode): boolean {
	return node.disposition !== "ambiguous";
}

/** Whether the plan contains an `ambiguous` node — these block "accept all"
 * (ADR-0042: "Accept all cannot sweep past an unresolved ambiguity"). */
export function hasAmbiguous(plan: readonly ResolvedNode[]): boolean {
	return plan.some((node) => node.disposition === "ambiguous");
}

/** The effective stage for a node: its explicit entry, else its default — every
 * acceptable node defaults to `accept` (the common path is accept-everything),
 * while an `ambiguous` node defaults to `reject` (it cannot be accepted yet). */
export function stageFor(buffer: StagingBuffer, node: ResolvedNode): NodeStage {
	return buffer[node.handle] ?? (isAcceptable(node) ? "accept" : "reject");
}

/** Toggle one node's stage, respecting the ambiguous accept-block: a request to
 * `accept` an unacceptable node is ignored (it stays reject-only). Returns a NEW
 * buffer (the caller holds it in component state). */
export function setStage(
	buffer: StagingBuffer,
	node: ResolvedNode,
	stage: NodeStage,
): StagingBuffer {
	if (stage === "accept" && !isAcceptable(node)) {
		return buffer;
	}
	return { ...buffer, [node.handle]: stage };
}

/** Stage EVERY acceptable node `accept` (ambiguous nodes stay `reject`) — the
 * "Accept all" affordance. Ambiguous nodes are explicitly rejected so the commit
 * vector is total and unambiguous. */
export function acceptAll(plan: readonly ResolvedNode[]): StagingBuffer {
	const next: Record<string, NodeStage> = {};
	for (const node of plan) {
		next[node.handle] = isAcceptable(node) ? "accept" : "reject";
	}
	return next;
}

/** Stage EVERY node `reject` — the "Reject all" affordance. */
export function rejectAll(plan: readonly ResolvedNode[]): StagingBuffer {
	const next: Record<string, NodeStage> = {};
	for (const node of plan) {
		next[node.handle] = "reject";
	}
	return next;
}

/** Whether every node has an explicit accepted choice (no node left `reject`).
 * Used to label the commit button (full accept vs partial). */
export function allAccepted(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
): boolean {
	return plan.every((node) => stageFor(buffer, node) === "accept");
}

/** Whether every node is staged `reject` — the commit is effectively a reject-all
 * (Core declines the whole graph; nothing is written). */
export function allRejected(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
): boolean {
	return plan.every((node) => stageFor(buffer, node) === "reject");
}

/** Build the per-node `decisions[]` vector the commit sends (ADR-0042): one entry
 * per plan node keyed by handle, each carrying its effective stage. A vector of
 * all-accepts is the safe/explicit "accept everything unchanged"; an all-reject
 * vector is the reject-all path. No per-node `entity_id`/`edited_fields` overrides
 * yet — the picker (#181) and inline edit are out of scope for this card. */
export function buildDecisions(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
): NodeDecision[] {
	return plan.map((node) => ({
		handle: node.handle,
		decision: stageFor(buffer, node),
	}));
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
	/** The handle of the rejected target whose link drops. A single Todo can lose
	 * MORE than one link (its project AND a person), so a stable render key must
	 * combine this with `todoHandle` — `todoHandle` alone collides when two notices
	 * share one Todo and React would drop the second. */
	readonly targetHandle: string;
	/** The Todo's label, for display. */
	readonly todoLabel: string;
	/** A human sentence describing the dropped link. */
	readonly message: string;
}

/** One intended link between two graph handles, parsed from the proposal payload
 * (the same `links[]` Core stores). Only `todo_project`/`todo_person` matter for
 * the downgrade notice (a `journal_ref` to a rejected entity collapses to text,
 * not a Todo downgrade). */
export interface GraphLink {
	readonly kind: "todo_project" | "todo_person" | "journal_ref";
	readonly from: string;
	readonly to: string;
}

/** Compute the downgrade notices for the current staging (ADR-0042 reconcile): for
 * every `todo_project`/`todo_person` link whose `from` Todo is staged accept and
 * whose `to` target is staged reject, the link drops and the Todo lands standalone
 * — surfaced so the user sees the downgrade before Apply. */
export function downgradeNotices(
	plan: readonly ResolvedNode[],
	links: readonly GraphLink[],
	buffer: StagingBuffer,
): DowngradeNotice[] {
	const byHandle = new Map(plan.map((node) => [node.handle, node]));
	const isAccepted = (handle: string): boolean => {
		const node = byHandle.get(handle);
		return node !== undefined && stageFor(buffer, node) === "accept";
	};
	const isRejected = (handle: string): boolean => {
		const node = byHandle.get(handle);
		return node !== undefined && stageFor(buffer, node) === "reject";
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
			out.push({ kind, from, to });
		}
	}
	return out;
}
