import type { NodeDecision, ResolvedNode } from "@inkstone/protocol";
import { parseAliases } from "@/lib/entityFields";

/**
 * Pure staging logic for the `apply_intent_graph` sequential-review card
 * (ADR-0042). The whole graph is ONE Core Proposal, one park, one atomic apply;
 * "sequential" is purely client-side. The user walks the resolved plan node by
 * node, accumulating per-node accept/reject LOCALLY — nothing is written until
 * commit — then commits ONE `proposal/decide` carrying a `decisions[]` vector.
 *
 * This module owns the rules a card just renders: the per-node stage map, what
 * "accept all" can sweep (an `ambiguous` node has no picker yet — #181 — so it
 * BLOCKS accept-all and is reject-only), the per-node inline EDIT of a create node
 * (the `edited_fields` correction Core merges before minting), the decisions[] the
 * commit sends, and the reconcile notice when rejecting a node a surviving Todo
 * links to.
 */

/** A node's staged choice in the local buffer (component state, not the store). */
export type NodeStage = "accept" | "reject";

/** The per-node staging buffer, keyed by graph handle. A handle with no entry is
 * "undecided" — the user has not stepped past it yet. */
export type StagingBuffer = Readonly<Record<string, NodeStage>>;

/** Whether a node's disposition permits `accept`. `create`/`reuse` are freely
 * acceptable. An `ambiguous` node has no silent fallback (ADR-0042), so it is
 * reject-only UNTIL the user picks one of its candidates: a pick is recorded as
 * that candidate's `entity_id` in the repoint buffer ({@link repointFor}), which
 * collapses the node `ambiguous → reuse` at decide. So an ambiguous node is
 * acceptable iff a candidate has been picked (#181 disambiguation picker).
 *
 * `repoints` defaults to `{}` so a caller that only has a node (no pick context)
 * still reads the pre-pick truth: a create/reuse node is acceptable, an ambiguous
 * one is not. */
export function isAcceptable(
	node: ResolvedNode,
	repoints: RepointBuffer = {},
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
export type RepointBuffer = Readonly<Record<string, string | null>>;

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
	// `Object.hasOwn`, not `key in buffer`: `handle` is an unvalidated model-supplied
	// wire string (protocol `ResolvedNode.handle` is a bare string, no `@` pattern), so
	// a handle equal to a prototype key ("toString", "constructor", "__proto__") would
	// make `in` true on an EMPTY buffer and return `Object.prototype.toString` — a
	// function, not `string | null` — which would then ride to Core as a bogus
	// `entity_id`. Same hardening the proposal-kind lookup already uses (ProposalCard).
	if (Object.hasOwn(buffer, node.handle)) return buffer[node.handle];
	if (node.disposition !== "create") return null;
	const near = node.near_matches ?? [];
	return near.length === 1 ? near[0].entity_id : null;
}

/** Whether the plan contains an `ambiguous` node — these block "accept all"
 * (ADR-0042: "Accept all cannot sweep past an unresolved ambiguity"). */
export function hasAmbiguous(plan: readonly ResolvedNode[]): boolean {
	return plan.some((node) => node.disposition === "ambiguous");
}

/** The effective stage for a node: its explicit entry, else its default — every
 * acceptable node defaults to `accept` (the common path is accept-everything),
 * while an UNPICKED `ambiguous` node defaults to `reject` (it cannot be accepted
 * yet). A picked ambiguous node is acceptable, so it defaults to `accept` and a
 * plain Apply sweeps it in like any reuse — hence `repoints` is consulted. */
export function stageFor(
	buffer: StagingBuffer,
	node: ResolvedNode,
	repoints: RepointBuffer = {},
): NodeStage {
	return (
		buffer[node.handle] ?? (isAcceptable(node, repoints) ? "accept" : "reject")
	);
}

/** Toggle one node's stage, respecting the ambiguous accept-block: a request to
 * `accept` an unacceptable node is ignored (it stays reject-only). A picked
 * ambiguous node IS acceptable, so its accept is honored — hence `repoints` is
 * consulted. Returns a NEW buffer (the caller holds it in component state). */
export function setStage(
	buffer: StagingBuffer,
	node: ResolvedNode,
	stage: NodeStage,
	repoints: RepointBuffer = {},
): StagingBuffer {
	if (stage === "accept" && !isAcceptable(node, repoints)) {
		return buffer;
	}
	return { ...buffer, [node.handle]: stage };
}

/** Stage EVERY acceptable node `accept` (an UNPICKED ambiguous node stays
 * `reject`) — the "Accept all" affordance. A picked ambiguous node is acceptable
 * (its candidate is chosen), so it is swept into `accept`; unpicked ambiguous
 * nodes are explicitly rejected so the commit vector is total and unambiguous. */
export function acceptAll(
	plan: readonly ResolvedNode[],
	repoints: RepointBuffer = {},
): StagingBuffer {
	const next: Record<string, NodeStage> = {};
	for (const node of plan) {
		next[node.handle] = isAcceptable(node, repoints) ? "accept" : "reject";
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
 * Used to label the commit button (full accept vs partial). `repoints` is consulted
 * so a PICKED ambiguous node (default `accept`) counts as accepted. */
export function allAccepted(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
	repoints: RepointBuffer = {},
): boolean {
	return plan.every((node) => stageFor(buffer, node, repoints) === "accept");
}

/** Whether every node is staged `reject` — the commit is effectively a reject-all
 * (Core declines the whole graph; nothing is written). `repoints` is consulted so a
 * PICKED ambiguous node (default `accept`) is correctly NOT counted as rejected. */
export function allRejected(
	plan: readonly ResolvedNode[],
	buffer: StagingBuffer,
	repoints: RepointBuffer = {},
): boolean {
	return plan.every((node) => stageFor(buffer, node, repoints) === "reject");
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
export type DraftBuffer = Readonly<Record<string, GraphNodeDraft>>;

/** Read `key` off an unknown record as a string, degrading anything else to "". */
function readString(source: unknown, key: string): string {
	if (source && typeof source === "object" && key in source) {
		const value = (source as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
	}
	return "";
}

/** Read `key` off an unknown record as a `string[]`, dropping non-strings; [] else. */
function readStringArray(source: unknown, key: string): string[] {
	if (source && typeof source === "object" && key in source) {
		const value = (source as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			return value.filter((a): a is string => typeof a === "string");
		}
	}
	return [];
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
	drafts: DraftBuffer = {},
	entities: Map<string, Record<string, unknown>> = new Map(),
	repoints: RepointBuffer = {},
): NodeDecision[] {
	return plan.map((node) => {
		const decision = stageFor(buffer, node, repoints);
		if (decision === "accept") {
			const repoint = repointFor(repoints, node);
			// An accepted `ambiguous` node is reuse-only: it is acceptable SOLELY
			// because a candidate was picked, and that pick rides as the `entity_id`
			// override Core collapses ambiguous → reuse (#181). Self-defend the
			// no-bare-ambiguous-accept invariant HERE, in the module, rather than
			// trusting the caller: if an accept survived in the buffer but the pick was
			// since cleared (a stale-buffer desync a future "clear pick" UI could
			// produce), `repoint` is null — emit a plain reject, NEVER a bare ambiguous
			// accept (Core fails the whole atomic apply on one).
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
				const draft = drafts[node.handle];
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
