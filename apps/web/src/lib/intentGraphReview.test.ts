import type { ResolvedNode } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import {
	acceptAll,
	allAccepted,
	allRejected,
	buildDecisions,
	buildEditedFields,
	candidateSubtitle,
	downgradeNotices,
	draftLabel,
	draftRequiredEmpty,
	type GraphLink,
	type GraphNodeDraft,
	getOwn,
	isAcceptable,
	type NodeStage,
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
} from "./intentGraphReview.js";

const createTodo: ResolvedNode = {
	handle: "@rodeo",
	type: "todo",
	disposition: "create",
	label: "Figure out the Rodeo side",
};
const reuseProject: ResolvedNode = {
	handle: "@leadads",
	type: "project",
	disposition: "reuse",
	label: "Lead Ads",
	entity_id: "p1",
};
const ambiguousPerson: ResolvedNode = {
	handle: "@morris",
	type: "person",
	disposition: "ambiguous",
	label: "Morris",
	candidates: [
		{ entity_id: "m1", label: "Morris" },
		{ entity_id: "m2", label: "Morris" },
	],
};

const PLAN: ResolvedNode[] = [createTodo, reuseProject, ambiguousPerson];

describe("isAcceptable", () => {
	it("create and reuse are acceptable; an unpicked ambiguous is not", () => {
		expect(isAcceptable(createTodo)).toBe(true);
		expect(isAcceptable(reuseProject)).toBe(true);
		expect(isAcceptable(ambiguousPerson)).toBe(false);
	});

	it("a PICKED ambiguous node is acceptable; an unpicked one is reject-only (#181)", () => {
		// The whole feature: a pick (an entity_id recorded in the repoint buffer)
		// flips the ambiguous node from reject-only to acceptable.
		expect(isAcceptable(ambiguousPerson, { "@morris": "m1" })).toBe(true);
		expect(isAcceptable(ambiguousPerson, {})).toBe(false);
		// A repoint entry for a DIFFERENT handle does not make THIS node acceptable.
		expect(isAcceptable(ambiguousPerson, { "@other": "m1" })).toBe(false);
	});

	it("a create node's acceptability is unaffected by the repoint buffer", () => {
		expect(isAcceptable(createTodo, {})).toBe(true);
		expect(isAcceptable(createTodo, { "@rodeo": "x" })).toBe(true);
	});
});

// A model-supplied handle equal to an Object.prototype key must NOT make a
// handle-keyed buffer read surface an inherited member (the `in`/direct-index
// vs Object.hasOwn hazard the module already guards in `repointFor`). Pins the
// guard for the staging buffer + draft reads (stageFor / buildDecisions).
describe("prototype-key handle safety on the staging + draft buffers", () => {
	const protoTodo: ResolvedNode = {
		handle: "toString",
		type: "todo",
		disposition: "create",
		label: "toString",
	};

	it("getOwn returns undefined for an inherited key on an empty record", () => {
		expect(getOwn<NodeStage>({}, "toString")).toBeUndefined();
		expect(getOwn<NodeStage>({}, "constructor")).toBeUndefined();
		// An OWN entry is still returned.
		expect(getOwn({ toString: "accept" as NodeStage }, "toString")).toBe(
			"accept",
		);
	});

	it("stageFor falls back to the node default for a prototype-key handle, never an inherited fn", () => {
		const stage = stageFor({}, protoTodo);
		expect(stage).toBe("accept"); // create node default — not Object.prototype.toString
		expect(typeof stage).not.toBe("function");
	});

	it("buildDecisions ignores an inherited draft for a prototype-key handle (plain accept)", () => {
		// Empty drafts: a direct `drafts["toString"]` would surface the inherited
		// function and ride into buildEditedFields; getOwn must yield undefined → a
		// plain accept with no edited_fields.
		const vector = buildDecisions([protoTodo], {}, {}, new Map(), {});
		expect(vector).toEqual([{ handle: "toString", decision: "accept" }]);
		expect(vector[0]).not.toHaveProperty("edited_fields");
	});
});

describe("stageFor defaults", () => {
	it("acceptable nodes default to accept; an unpicked ambiguous defaults to reject", () => {
		const empty: StagingBuffer = {};
		expect(stageFor(empty, createTodo)).toBe("accept");
		expect(stageFor(empty, reuseProject)).toBe("accept");
		expect(stageFor(empty, ambiguousPerson)).toBe("reject");
	});

	it("a PICKED ambiguous node defaults to accept (it is now acceptable)", () => {
		// With a pick recorded, the ambiguous node's default flips to accept, so a
		// plain Apply (empty staging buffer) sweeps it in like any reuse node.
		expect(stageFor({}, ambiguousPerson, { "@morris": "m2" })).toBe("accept");
		// Without a pick it stays reject by default.
		expect(stageFor({}, ambiguousPerson, {})).toBe("reject");
	});

	it("an explicit entry overrides the default", () => {
		const buffer: StagingBuffer = { "@rodeo": "reject" };
		expect(stageFor(buffer, createTodo)).toBe("reject");
	});
});

describe("setStage respects the ambiguous accept-block (#181)", () => {
	it("ignores an accept request on an UNPICKED ambiguous node", () => {
		const buffer = setStage({}, ambiguousPerson, "accept");
		expect(stageFor(buffer, ambiguousPerson)).toBe("reject");
	});

	it("allows accept on a PICKED ambiguous node", () => {
		const buffer = setStage({}, ambiguousPerson, "accept", { "@morris": "m1" });
		expect(buffer["@morris"]).toBe("accept");
	});

	it("accepts a create/reuse node", () => {
		const buffer = setStage({ "@rodeo": "reject" }, createTodo, "accept");
		expect(buffer["@rodeo"]).toBe("accept");
	});

	it("can reject any node, including a picked ambiguous one", () => {
		expect(setStage({}, ambiguousPerson, "reject")["@morris"]).toBe("reject");
		expect(
			setStage({}, ambiguousPerson, "reject", { "@morris": "m1" })["@morris"],
		).toBe("reject");
	});
});

describe("acceptAll / rejectAll", () => {
	it("acceptAll accepts every acceptable node and rejects an UNPICKED ambiguous", () => {
		const buffer = acceptAll(PLAN);
		expect(buffer["@rodeo"]).toBe("accept");
		expect(buffer["@leadads"]).toBe("accept");
		expect(buffer["@morris"]).toBe("reject");
	});

	it("acceptAll accepts a PICKED ambiguous node", () => {
		const buffer = acceptAll(PLAN, { "@morris": "m1" });
		expect(buffer["@morris"]).toBe("accept");
		expect(buffer["@rodeo"]).toBe("accept");
	});

	it("rejectAll rejects every node", () => {
		const buffer = rejectAll(PLAN);
		expect(Object.values(buffer)).toEqual(["reject", "reject", "reject"]);
	});
});

describe("allAccepted / allRejected", () => {
	it("a plan with an ambiguous node is never all-accepted by default", () => {
		expect(allAccepted(PLAN, {})).toBe(false);
	});

	it("acceptAll on an ambiguous-free plan is all-accepted", () => {
		const plan = [createTodo, reuseProject];
		expect(allAccepted(plan, acceptAll(plan))).toBe(true);
	});

	it("rejectAll is all-rejected", () => {
		expect(allRejected(PLAN, rejectAll(PLAN))).toBe(true);
	});
});

describe("buildDecisions", () => {
	it("builds a vector of all-accepts for an unchanged ambiguous-free plan", () => {
		const plan = [createTodo, reuseProject];
		expect(buildDecisions(plan, {})).toEqual([
			{ handle: "@rodeo", decision: "accept" },
			{ handle: "@leadads", decision: "accept" },
		]);
	});

	it("reflects a rejected node in the vector", () => {
		const buffer = setStage({}, reuseProject, "reject");
		expect(buildDecisions([createTodo, reuseProject], buffer)).toEqual([
			{ handle: "@rodeo", decision: "accept" },
			{ handle: "@leadads", decision: "reject" },
		]);
	});

	it("rejects an ambiguous node by default (it cannot be accepted)", () => {
		const vector = buildDecisions(PLAN, {});
		expect(vector.find((d) => d.handle === "@morris")?.decision).toBe("reject");
	});

	it("reject-all produces an all-reject vector", () => {
		const vector = buildDecisions(PLAN, rejectAll(PLAN));
		expect(vector.every((d) => d.decision === "reject")).toBe(true);
	});
});

describe("buildDecisions resolves a picked ambiguous node (the disambiguation picker, #181)", () => {
	it("a picked ambiguous node submits its entity_id as an accept", () => {
		// Default staging + a pick → the ambiguous node accepts WITH the chosen
		// entity_id (the override Core collapses ambiguous → reuse). The whole graph
		// is now applicable.
		const repoints: RepointBuffer = { "@morris": "m1" };
		const vector = buildDecisions(PLAN, {}, {}, new Map(), repoints);
		expect(vector.find((d) => d.handle === "@morris")).toEqual({
			handle: "@morris",
			decision: "accept",
			entity_id: "m1",
		});
	});

	// THE KEY RISK (the half-relaxed guard): an UNPICKED ambiguous node must NEVER
	// ride a bare accept — Core fails the whole atomic apply on an unresolved
	// ambiguous accept. It must stay a plain reject, carrying no entity_id.
	it("an unpicked ambiguous node stays a plain reject — never a bare accept", () => {
		const morris = buildDecisions(PLAN, {}).find((d) => d.handle === "@morris");
		expect(morris).toEqual({ handle: "@morris", decision: "reject" });
		expect(morris).not.toHaveProperty("entity_id");
	});

	it("a rejected pick drops the entity_id (a rejected node is not reused)", () => {
		const repoints: RepointBuffer = { "@morris": "m1" };
		// The user picked, then rejected the node anyway.
		const buffer = setStage({}, ambiguousPerson, "reject", repoints);
		const morris = buildDecisions(PLAN, buffer, {}, new Map(), repoints).find(
			(d) => d.handle === "@morris",
		);
		expect(morris).toEqual({ handle: "@morris", decision: "reject" });
		expect(morris).not.toHaveProperty("entity_id");
	});

	it("never emits edited_fields for a picked ambiguous node (entity_id XOR edited_fields)", () => {
		// A picked ambiguous node reuses an existing entity, so it can NEVER carry an
		// edited_fields correction (Core rejects both — mutually exclusive). Structural,
		// but pinned so a refactor can't leak an edit onto a reuse.
		const repoints: RepointBuffer = { "@morris": "m1" };
		const morris = buildDecisions(PLAN, {}, {}, new Map(), repoints).find(
			(d) => d.handle === "@morris",
		);
		expect(morris).not.toHaveProperty("edited_fields");
	});

	// Defense-in-depth: the no-bare-ambiguous-accept invariant is a MODULE guarantee,
	// not a caller contract. If a stale buffer holds `accept` for an ambiguous handle
	// but the pick was since cleared (repoints no longer resolves it) — a desync a
	// future "clear pick" UI could produce — buildDecisions must NOT emit a bare
	// ambiguous accept (Core fails the whole atomic apply). It coerces to reject.
	it("coerces a stale-accept ambiguous node with no pick to reject (never a bare accept)", () => {
		const staleBuffer: StagingBuffer = { "@morris": "accept" };
		const morris = buildDecisions(PLAN, staleBuffer, {}, new Map(), {}).find(
			(d) => d.handle === "@morris",
		);
		expect(morris).toEqual({ handle: "@morris", decision: "reject" });
		expect(morris).not.toHaveProperty("entity_id");
	});
});

describe("summarizeDecisions — count/decision derived from the built vector", () => {
	it("counts accepts and detects an all-reject vector", () => {
		expect(summarizeDecisions(buildDecisions(PLAN, {}))).toEqual({
			acceptedCount: 2, // @rodeo + @leadads accept; @morris (ambiguous) rejects
			allRejected: false,
		});
		expect(summarizeDecisions(buildDecisions(PLAN, rejectAll(PLAN)))).toEqual({
			acceptedCount: 0,
			allRejected: true,
		});
	});

	it("an empty vector is NOT all-rejected (no nodes to reject)", () => {
		expect(summarizeDecisions([])).toEqual({
			acceptedCount: 0,
			allRejected: false,
		});
	});

	// THE DESYNC GUARD (cross-engine finding): a stale-accept ambiguous node with no
	// pick is coerced to reject by buildDecisions; the summary derived from that vector
	// must therefore report all-rejected — NOT "Apply 1 item". Deriving the count from a
	// parallel stageFor pass would disagree with the vector actually sent.
	it("agrees with the coerced vector for a stale-accept ambiguous-only plan", () => {
		const plan = [ambiguousPerson];
		const staleBuffer: StagingBuffer = { "@morris": "accept" };
		const decisions = buildDecisions(plan, staleBuffer, {}, new Map(), {});
		expect(decisions).toEqual([{ handle: "@morris", decision: "reject" }]);
		expect(summarizeDecisions(decisions)).toEqual({
			acceptedCount: 0,
			allRejected: true,
		});
	});

	it("a picked ambiguous node counts as accepted", () => {
		const decisions = buildDecisions([ambiguousPerson], {}, {}, new Map(), {
			"@morris": "m1",
		});
		expect(summarizeDecisions(decisions)).toEqual({
			acceptedCount: 1,
			allRejected: false,
		});
	});
});

describe("candidateSubtitle — always a distinct disambiguator", () => {
	it("appends a short id fragment to the resolved subtitle", () => {
		expect(
			candidateSubtitle("01900000-0000-7000-8000-0000000000m1", "Met at Rodeo"),
		).toBe("Met at Rodeo · #01900000");
	});

	it("falls back to the id fragment alone when the subtitle is missing/blank", () => {
		expect(candidateSubtitle("abc1234567", null)).toBe("#abc12345");
		expect(candidateSubtitle("abc1234567", "   ")).toBe("#abc12345");
	});

	it("two same-named candidates with identical (or absent) subtitles never collide", () => {
		// The exact failure mode: two People both render "Person" — the id suffix
		// guarantees the two lines differ.
		const a = candidateSubtitle("aaaaaaaa-1111", "Person");
		const b = candidateSubtitle("bbbbbbbb-2222", "Person");
		expect(a).not.toBe(b);
		const c = candidateSubtitle("cccccccc-3333", null);
		const d = candidateSubtitle("dddddddd-4444", null);
		expect(c).not.toBe(d);
	});
});

// A `create` node carrying near_matches (ADR-0042 amendment). The reported bug:
// "Lead Ads testing" proposed New while "Lead Ads" exists.
const nearMatchProject: ResolvedNode = {
	handle: "@leadads",
	type: "project",
	disposition: "create",
	label: "Lead Ads testing",
	near_matches: [{ entity_id: "existing-leadads", label: "Lead Ads" }],
};
// A create node with TWO near-matches — surfaced advisorily, never auto-picked.
const multiNearMatchProject: ResolvedNode = {
	handle: "@leadads2",
	type: "project",
	disposition: "create",
	label: "Lead Ads testing",
	near_matches: [
		{ entity_id: "lead-ads-1", label: "Lead Ads" },
		{ entity_id: "lead-ads-2", label: "Lead Ads work" },
	],
};

describe("repointFor — default-to-existing on a single near-match", () => {
	it("a single-near-match create node defaults to its existing entity_id", () => {
		expect(repointFor({}, nearMatchProject)).toBe("existing-leadads");
	});

	it("a create node with NO near-matches has no default re-point", () => {
		expect(repointFor({}, createTodo)).toBeNull();
	});

	it("a create node with 2+ near-matches does NOT auto-pick (defers to the picker)", () => {
		expect(repointFor({}, multiNearMatchProject)).toBeNull();
	});

	it("an explicit 'create new instead' choice clears the default re-point", () => {
		const buffer: RepointBuffer = { "@leadads": null };
		expect(repointFor(buffer, nearMatchProject)).toBeNull();
	});

	it("an explicit re-point id overrides (picker future-proofing)", () => {
		const buffer: RepointBuffer = { "@leadads": "existing-leadads" };
		expect(repointFor(buffer, nearMatchProject)).toBe("existing-leadads");
	});

	// A model-supplied handle equal to an Object.prototype key must NOT make the
	// empty-buffer lookup return an inherited function (the `in` vs Object.hasOwn
	// hazard). Such a handle has no explicit entry → falls through to the near-match
	// default (here: none, so null), never `Object.prototype.toString`.
	it("a prototype-key handle does not leak an inherited function from an empty buffer", () => {
		const protoHandleNoNear: ResolvedNode = {
			handle: "toString",
			type: "project",
			disposition: "create",
			label: "toString",
		};
		const result = repointFor({}, protoHandleNoNear);
		expect(result).toBeNull();
		expect(typeof result).not.toBe("function");
		// With a single near-match it falls through to that default, not the prototype fn.
		const protoHandleWithNear: ResolvedNode = {
			...protoHandleNoNear,
			near_matches: [{ entity_id: "real-id", label: "toString" }],
		};
		expect(repointFor({}, protoHandleWithNear)).toBe("real-id");
	});
});

describe("buildDecisions with near-match re-point", () => {
	it("defaults a single-near-match create node to accept WITH the existing entity_id", () => {
		const plan = [nearMatchProject];
		expect(buildDecisions(plan, {}, {}, new Map(), {})).toEqual([
			{ handle: "@leadads", decision: "accept", entity_id: "existing-leadads" },
		]);
	});

	it("a 'create new instead' choice commits a plain create accept (no entity_id)", () => {
		const plan = [nearMatchProject];
		const repoints: RepointBuffer = { "@leadads": null };
		expect(buildDecisions(plan, {}, {}, new Map(), repoints)).toEqual([
			{ handle: "@leadads", decision: "accept" },
		]);
	});

	it("a multi-near-match node defaults to a plain create accept (no auto entity_id)", () => {
		const plan = [multiNearMatchProject];
		expect(buildDecisions(plan, {}, {}, new Map(), {})).toEqual([
			{ handle: "@leadads2", decision: "accept" },
		]);
	});

	it("a rejected near-match node commits a plain reject (no entity_id)", () => {
		const plan = [nearMatchProject];
		const buffer = setStage({}, nearMatchProject, "reject");
		expect(buildDecisions(plan, buffer, {}, new Map(), {})).toEqual([
			{ handle: "@leadads", decision: "reject" },
		]);
	});

	// Mutual exclusion (ADR-0042): a re-point WINS over an edit draft on the same node
	// — entity_id and edited_fields cannot ride together (Core rejects both). Pins the
	// early-return precedence so a branch reorder (draft-first) is caught.
	it("re-point wins over an edit draft on the same node (entity_id, no edited_fields)", () => {
		const plan = [nearMatchProject];
		const drafts = {
			"@leadads": {
				type: "project",
				name: "Lead Ads testing — renamed",
				outcome: "",
				note: "",
			} as GraphNodeDraft,
		};
		// Default buffer → single near-match re-point active; the draft must be ignored.
		expect(buildDecisions(plan, {}, drafts, new Map(), {})).toEqual([
			{ handle: "@leadads", decision: "accept", entity_id: "existing-leadads" },
		]);
	});
});

describe("downgradeNotices", () => {
	const links: GraphLink[] = [
		{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
		{ kind: "journal_ref", from: "@je", to: "@leadads" },
	];

	it("warns when an accepted Todo's rejected project link drops", () => {
		const buffer = setStage({}, reuseProject, "reject"); // todo accept (default)
		const notices = downgradeNotices(PLAN, links, buffer);
		expect(notices).toHaveLength(1);
		expect(notices[0].todoHandle).toBe("@rodeo");
		expect(notices[0].message).toMatch(/without its project link/i);
	});

	it("no notice when both endpoints are accepted", () => {
		const plan = [createTodo, reuseProject];
		expect(downgradeNotices(plan, links, acceptAll(plan))).toEqual([]);
	});

	// A Todo linked to an AMBIGUOUS person/project target: once the user picks a
	// candidate, the target is acceptable and the link is KEPT at apply, so no
	// downgrade notice may fire. Without threading `repoints`, `stageFor` returns the
	// ambiguous node's pre-pick `reject` default and a SPURIOUS notice appears.
	it("no notice when a Todo's ambiguous link target has been PICKED", () => {
		// @rodeo (todo, accept default) links to @morris (ambiguous person).
		const personLinks: GraphLink[] = [
			{ kind: "todo_person", from: "@rodeo", to: "@morris" },
		];
		// Unpicked: @morris sits at its reject default → the link genuinely drops.
		expect(downgradeNotices(PLAN, personLinks, {})).toHaveLength(1);
		// Picked: @morris is acceptable (default accept) → the link is kept, no notice.
		expect(
			downgradeNotices(PLAN, personLinks, {}, { "@morris": "m1" }),
		).toEqual([]);
	});

	it("no notice when the Todo itself is rejected", () => {
		let buffer = setStage({}, reuseProject, "reject");
		buffer = setStage(buffer, createTodo, "reject");
		expect(downgradeNotices(PLAN, links, buffer)).toEqual([]);
	});

	it("ignores journal_ref links (those collapse to text, not a Todo downgrade)", () => {
		const onlyJournalRef: GraphLink[] = [
			{ kind: "journal_ref", from: "@je", to: "@leadads" },
		];
		const buffer = setStage({}, reuseProject, "reject");
		expect(downgradeNotices(PLAN, onlyJournalRef, buffer)).toEqual([]);
	});

	it("warns with the PERSON copy when an accepted Todo's rejected person link drops", () => {
		const reusePerson: ResolvedNode = {
			handle: "@alice",
			type: "person",
			disposition: "reuse",
			label: "Alice",
			entity_id: "a1",
		};
		const plan = [createTodo, reusePerson];
		const personLinks: GraphLink[] = [
			{ kind: "todo_person", from: "@rodeo", to: "@alice" },
		];
		const buffer = setStage({}, reusePerson, "reject"); // todo accept (default)
		const notices = downgradeNotices(plan, personLinks, buffer);
		expect(notices).toHaveLength(1);
		expect(notices[0].todoHandle).toBe("@rodeo");
		// The person variant says "without its link to", NOT "without its project link to".
		expect(notices[0].message).toMatch(/without its link to/i);
		expect(notices[0].message).not.toMatch(/project link/i);
	});

	it("emits TWO distinct, uniquely-keyed notices when one Todo loses both its links", () => {
		// The #179 graph wires @rodeo with BOTH a todo_project (@leadads) and a
		// todo_person (@morris). Reject both while keeping the Todo: two notices,
		// each keyed by (todoHandle, targetHandle) — never a colliding key.
		const reusePerson: ResolvedNode = {
			handle: "@morris",
			type: "person",
			disposition: "reuse",
			label: "Morris",
			entity_id: "m1",
		};
		const plan = [createTodo, reuseProject, reusePerson];
		const bothLinks: GraphLink[] = [
			{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
			{ kind: "todo_person", from: "@rodeo", to: "@morris" },
		];
		let buffer = setStage({}, reuseProject, "reject");
		buffer = setStage(buffer, reusePerson, "reject"); // @rodeo stays accepted (default)
		const notices = downgradeNotices(plan, bothLinks, buffer);
		expect(notices).toHaveLength(2);
		// Both notices are about @rodeo, but their (todoHandle:targetHandle) keys differ.
		const keys = notices.map((n) => `${n.todoHandle}:${n.targetHandle}`);
		expect(new Set(keys).size).toBe(2);
		expect(keys).toContain("@rodeo:@leadads");
		expect(keys).toContain("@rodeo:@morris");
	});
});

describe("parseGraphLinks", () => {
	it("parses the three known link kinds and drops malformed entries", () => {
		const payload = {
			links: [
				{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
				{ kind: "todo_person", from: "@rodeo", to: "@morris", role: "related" },
				{ kind: "journal_ref", from: "@je", to: "@morris" },
				{ kind: "bogus", from: "@a", to: "@b" },
				{ from: "@a" },
				null,
			],
		};
		expect(parseGraphLinks(payload)).toEqual([
			{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
			{ kind: "todo_person", from: "@rodeo", to: "@morris" },
			{ kind: "journal_ref", from: "@je", to: "@morris" },
		]);
	});

	it("degrades a missing/non-array links field to []", () => {
		expect(parseGraphLinks({})).toEqual([]);
		expect(parseGraphLinks(null)).toEqual([]);
		expect(parseGraphLinks({ links: "nope" })).toEqual([]);
	});
});

// The graph payload carries each node's ORIGINAL proposed fields; editing reads from
// and diffs against it. A representative #179-shaped payload with all three types,
// each carrying an optional, plus a reuse hint that is irrelevant to seeding.
const GRAPH_PAYLOAD = {
	entities: [
		{ handle: "@leadads", type: "project", name: "Lead Ads", note: "guessed" },
		{
			handle: "@morris",
			type: "person",
			name: "Morris",
			note: "from note",
			aliases: ["Mo"],
		},
		{ handle: "@rodeo", type: "todo", title: "Figure out the Rodeo side" },
	],
	links: [{ kind: "todo_project", from: "@rodeo", to: "@leadads" }],
};

describe("parseGraphEntities", () => {
	it("indexes entities by handle", () => {
		const map = parseGraphEntities(GRAPH_PAYLOAD);
		expect(map.size).toBe(3);
		expect(map.get("@morris")?.name).toBe("Morris");
	});

	it("degrades a missing/non-array entities field to an empty map", () => {
		expect(parseGraphEntities({}).size).toBe(0);
		expect(parseGraphEntities(null).size).toBe(0);
		expect(parseGraphEntities({ entities: "nope" }).size).toBe(0);
	});

	it("skips entries without a string handle", () => {
		const map = parseGraphEntities({ entities: [{ type: "todo" }, null, 7] });
		expect(map.size).toBe(0);
	});
});

describe("seedNodeDraft", () => {
	const entities = parseGraphEntities(GRAPH_PAYLOAD);

	it("seeds a todo draft (title/note) from the payload", () => {
		expect(seedNodeDraft(createTodo, entities.get("@rodeo"))).toEqual({
			type: "todo",
			title: "Figure out the Rodeo side",
			note: "",
		});
	});

	it("seeds a person draft, joining aliases with a comma", () => {
		const node: ResolvedNode = {
			handle: "@morris",
			type: "person",
			disposition: "create",
			label: "Morris",
		};
		expect(seedNodeDraft(node, entities.get("@morris"))).toEqual({
			type: "person",
			name: "Morris",
			note: "from note",
			aliases: "Mo",
		});
	});

	it("returns null for a reuse/ambiguous node (not editable)", () => {
		expect(seedNodeDraft(reuseProject, entities.get("@leadads"))).toBeNull();
		expect(seedNodeDraft(ambiguousPerson, entities.get("@morris"))).toBeNull();
	});

	it("returns null when the node's entity is missing from the payload", () => {
		const orphan: ResolvedNode = {
			handle: "@ghost",
			type: "todo",
			disposition: "create",
			label: "Ghost",
		};
		expect(seedNodeDraft(orphan, entities.get("@ghost"))).toBeNull();
	});
});

describe("draftRequiredEmpty / draftLabel", () => {
	it("flags a blank required field (title/name)", () => {
		expect(draftRequiredEmpty({ type: "todo", title: "  ", note: "x" })).toBe(
			true,
		);
		expect(
			draftRequiredEmpty({
				type: "person",
				name: "Lev",
				note: "",
				aliases: "",
			}),
		).toBe(false);
	});

	it("draftLabel shows the edited title/name, falling back to the node label", () => {
		expect(
			draftLabel(createTodo, { type: "todo", title: "Renamed", note: "" }),
		).toBe("Renamed");
		// A blanked required field falls back to the node's original label.
		expect(
			draftLabel(createTodo, { type: "todo", title: "   ", note: "" }),
		).toBe("Figure out the Rodeo side");
	});
});

describe("buildEditedFields", () => {
	const entities = parseGraphEntities(GRAPH_PAYLOAD);
	const leadads = entities.get("@leadads");
	const morris = entities.get("@morris");
	const rodeo = entities.get("@rodeo");

	it("returns undefined for an unchanged draft (no correction sent)", () => {
		const draft: GraphNodeDraft = {
			type: "todo",
			title: "Figure out the Rodeo side",
			note: "",
		};
		expect(buildEditedFields(rodeo, draft)).toBeUndefined();
	});

	it("emits only the changed required field", () => {
		const draft: GraphNodeDraft = {
			type: "todo",
			title: "Sort out the Rodeo logistics",
			note: "",
		};
		expect(buildEditedFields(rodeo, draft)).toEqual({
			title: "Sort out the Rodeo logistics",
		});
	});

	it("emits null to CLEAR a blanked proposed optional", () => {
		// The project proposed note:"guessed"; the user blanks it.
		const draft: GraphNodeDraft = {
			type: "project",
			name: "Lead Ads",
			outcome: "",
			note: "",
		};
		expect(buildEditedFields(leadads, draft)).toEqual({ note: null });
	});

	it("does not emit a blanked optional that was already absent", () => {
		// The todo had no note; leaving it blank is not a change.
		const draft: GraphNodeDraft = {
			type: "todo",
			title: "Figure out the Rodeo side",
			note: "",
		};
		expect(buildEditedFields(rodeo, draft)).toBeUndefined();
	});

	it("trims values and treats a whitespace-only optional as a clear", () => {
		const draft: GraphNodeDraft = {
			type: "project",
			name: "  Lead Ads  ",
			outcome: "",
			note: "   ",
		};
		// name unchanged after trim; note blanked → clear.
		expect(buildEditedFields(leadads, draft)).toEqual({ note: null });
	});

	it("diffs aliases as an array; clears to null when emptied", () => {
		const cleared: GraphNodeDraft = {
			type: "person",
			name: "Morris",
			note: "from note",
			aliases: "",
		};
		expect(buildEditedFields(morris, cleared)).toEqual({ aliases: null });

		const changed: GraphNodeDraft = {
			type: "person",
			name: "Morris",
			note: "from note",
			aliases: "Mo, Maurice",
		};
		expect(buildEditedFields(morris, changed)).toEqual({
			aliases: ["Mo", "Maurice"],
		});
	});

	it("never emits a blanked required field (it cannot be cleared)", () => {
		const draft: GraphNodeDraft = {
			type: "todo",
			title: "",
			note: "new note",
		};
		// Title omitted (blank required); only the note change rides.
		expect(buildEditedFields(rodeo, draft)).toEqual({ note: "new note" });
	});
});

describe("buildDecisions with edits", () => {
	const entities = parseGraphEntities(GRAPH_PAYLOAD);
	const plan = [createTodo, reuseProject];

	it("folds edited_fields into an accepted create node's decision", () => {
		const drafts = {
			"@rodeo": { type: "todo", title: "Renamed", note: "" } as GraphNodeDraft,
		};
		expect(buildDecisions(plan, {}, drafts, entities)).toEqual([
			{
				handle: "@rodeo",
				decision: "accept",
				edited_fields: { title: "Renamed" },
			},
			{ handle: "@leadads", decision: "accept" },
		]);
	});

	it("omits edited_fields for an unchanged draft (plain accept)", () => {
		const drafts = {
			"@rodeo": {
				type: "todo",
				title: "Figure out the Rodeo side",
				note: "",
			} as GraphNodeDraft,
		};
		expect(buildDecisions(plan, {}, drafts, entities)).toEqual([
			{ handle: "@rodeo", decision: "accept" },
			{ handle: "@leadads", decision: "accept" },
		]);
	});

	it("drops the edit when the node is rejected (a rejected node is not minted)", () => {
		const drafts = {
			"@rodeo": { type: "todo", title: "Renamed", note: "" } as GraphNodeDraft,
		};
		const buffer = setStage({}, createTodo, "reject");
		expect(buildDecisions(plan, buffer, drafts, entities)).toEqual([
			{ handle: "@rodeo", decision: "reject" },
			{ handle: "@leadads", decision: "accept" },
		]);
	});

	it("is back-compatible: no drafts → plain decisions", () => {
		expect(buildDecisions(plan, {})).toEqual([
			{ handle: "@rodeo", decision: "accept" },
			{ handle: "@leadads", decision: "accept" },
		]);
	});
});
