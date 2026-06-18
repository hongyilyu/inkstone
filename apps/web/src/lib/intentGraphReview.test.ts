import type { ResolvedNode } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import {
	acceptAll,
	allAccepted,
	allRejected,
	buildDecisions,
	buildEditedFields,
	downgradeNotices,
	draftLabel,
	draftRequiredEmpty,
	type GraphLink,
	type GraphNodeDraft,
	hasAmbiguous,
	isAcceptable,
	parseGraphEntities,
	parseGraphLinks,
	rejectAll,
	type StagingBuffer,
	seedNodeDraft,
	setStage,
	stageFor,
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

describe("isAcceptable / hasAmbiguous", () => {
	it("create and reuse are acceptable; ambiguous is not", () => {
		expect(isAcceptable(createTodo)).toBe(true);
		expect(isAcceptable(reuseProject)).toBe(true);
		expect(isAcceptable(ambiguousPerson)).toBe(false);
	});

	it("hasAmbiguous detects an ambiguous node", () => {
		expect(hasAmbiguous(PLAN)).toBe(true);
		expect(hasAmbiguous([createTodo, reuseProject])).toBe(false);
	});
});

describe("stageFor defaults", () => {
	it("acceptable nodes default to accept; ambiguous defaults to reject", () => {
		const empty: StagingBuffer = {};
		expect(stageFor(empty, createTodo)).toBe("accept");
		expect(stageFor(empty, reuseProject)).toBe("accept");
		expect(stageFor(empty, ambiguousPerson)).toBe("reject");
	});

	it("an explicit entry overrides the default", () => {
		const buffer: StagingBuffer = { "@rodeo": "reject" };
		expect(stageFor(buffer, createTodo)).toBe("reject");
	});
});

describe("setStage respects the ambiguous accept-block (#181)", () => {
	it("ignores an accept request on an ambiguous node", () => {
		const buffer = setStage({}, ambiguousPerson, "accept");
		expect(stageFor(buffer, ambiguousPerson)).toBe("reject");
	});

	it("accepts a create/reuse node", () => {
		const buffer = setStage({ "@rodeo": "reject" }, createTodo, "accept");
		expect(buffer["@rodeo"]).toBe("accept");
	});

	it("can reject any node, including ambiguous", () => {
		expect(setStage({}, ambiguousPerson, "reject")["@morris"]).toBe("reject");
	});
});

describe("acceptAll / rejectAll", () => {
	it("acceptAll accepts every acceptable node and rejects ambiguous", () => {
		const buffer = acceptAll(PLAN);
		expect(buffer["@rodeo"]).toBe("accept");
		expect(buffer["@leadads"]).toBe("accept");
		expect(buffer["@morris"]).toBe("reject");
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
