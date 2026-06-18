import type { ResolvedNode } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import {
	acceptAll,
	allAccepted,
	allRejected,
	buildDecisions,
	downgradeNotices,
	type GraphLink,
	hasAmbiguous,
	isAcceptable,
	parseGraphLinks,
	rejectAll,
	type StagingBuffer,
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
