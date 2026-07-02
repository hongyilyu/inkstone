import { describe, expect, it } from "vitest";
import type {
	JournalEntry,
	JournalEntryBodyNode,
	LibraryItem,
	Person,
	Project,
	Todo,
} from "@/lib/libraryItems";
import { buildTimeline, focusEntityTimeline } from "@/lib/timeline";

/** A Journal Entry view-model with a mixed text + entity_ref body. */
const je = (
	id: string,
	occurredAt: string,
	body: JournalEntryBodyNode[],
	recency = 1,
): JournalEntry => ({
	id,
	kind: "journal_entry",
	occurredAt,
	body,
	recency,
	createdAt: "fixture",
});

const text = (t: string): JournalEntryBodyNode => ({ type: "text", text: t });

const ref = (
	refId: string,
	targetEntityId: string,
	targetKind: "person" | "project" | "todo",
	targetTitle: string,
): JournalEntryBodyNode => ({
	type: "entity_ref",
	refId,
	targetEntityId,
	targetKind,
	targetTitle,
});

const mkPerson = (id: string, name: string): Person => ({
	id,
	kind: "person",
	name,
	recency: 1,
	createdAt: "fixture",
});

const mkProject = (id: string, name: string): Project => ({
	id,
	kind: "project",
	name,
	status: "active",
	recency: 1,
	createdAt: "fixture",
});

const mkTodo = (id: string): Todo => ({
	id,
	kind: "todo",
	title: id,
	status: "active",
	personRefs: [],
	recency: 1,
	createdAt: "fixture",
});

describe("buildTimeline (ADR-0054 §4 — derived chronological projection)", () => {
	// Two days; the morning entry references a person, the afternoon a project.
	const world: LibraryItem[] = [
		mkPerson("person_priya", "Priya"),
		mkProject("proj_apiv2", "API v2"),
		mkTodo("todo_unrelated"),
		je("je_morning", "2026-06-10T09:00:00", [
			text("Synced with "),
			ref("r1", "person_priya", "person", "Priya"),
			text(" on scope."),
		]),
		je("je_afternoon", "2026-06-10T16:00:00", [
			text("Kicked off "),
			ref("r2", "proj_apiv2", "project", "API v2"),
		]),
		je("je_yesterday", "2026-06-09T20:00:00", [text("Quiet day.")]),
	];

	const timeline = buildTimeline(world);

	it("groups newest-day-first and orders within a day by occurred time", () => {
		expect(timeline.map((d) => d.day)).toEqual(["2026-06-10", "2026-06-09"]);
		expect(timeline[0]?.events.map((e) => e.entry.id)).toEqual([
			"je_morning",
			"je_afternoon",
		]);
	});

	it("excerpts the JE body text", () => {
		const morning = timeline[0]?.events[0];
		expect(morning?.excerpt).toBe("Synced with Priya on scope.");
	});

	it("surfaces the person chip the morning JE touches", () => {
		const chips = timeline[0]?.events[0]?.chips ?? [];
		expect(chips).toEqual([
			{ entityId: "person_priya", kind: "person", title: "Priya" },
		]);
	});

	it("surfaces the project chip the afternoon JE touches", () => {
		const chips = timeline[0]?.events[1]?.chips ?? [];
		expect(chips).toEqual([
			{ entityId: "proj_apiv2", kind: "project", title: "API v2" },
		]);
	});

	it("leaves a JE with no entity refs chip-less", () => {
		const yesterday = timeline[1]?.events[0];
		expect(yesterday?.chips).toEqual([]);
	});

	it("ignores non-Journal-Entry items (people/projects/todos are not spine rows)", () => {
		const ids = timeline.flatMap((d) => d.events.map((e) => e.entry.id));
		expect(ids).toEqual(["je_morning", "je_afternoon", "je_yesterday"]);
	});

	it("de-duplicates a chip referenced twice in one JE body", () => {
		const dup = buildTimeline([
			je("je_dup", "2026-06-10T09:00:00", [
				ref("r1", "person_priya", "person", "Priya"),
				text(" and again "),
				ref("r2", "person_priya", "person", "Priya"),
			]),
		]);
		expect(dup[0]?.events[0]?.chips).toEqual([
			{ entityId: "person_priya", kind: "person", title: "Priya" },
		]);
	});

	it("drops a ref missing its entity id or kind (unresolved mention)", () => {
		const partial = buildTimeline([
			je("je_partial", "2026-06-10T09:00:00", [
				{ type: "entity_ref", refId: "r1", targetTitle: "Ghost" },
			]),
		]);
		expect(partial[0]?.events[0]?.chips).toEqual([]);
	});
});

describe("focusEntityTimeline", () => {
	const world: LibraryItem[] = [
		je("je_priya", "2026-06-10T09:00:00", [
			text("With "),
			ref("r1", "person_priya", "person", "Priya"),
		]),
		je("je_apiv2", "2026-06-10T16:00:00", [
			ref("r2", "proj_apiv2", "project", "API v2"),
		]),
		je("je_none", "2026-06-09T20:00:00", [text("Solo work.")]),
	];

	it("returns only the JEs that reference the given entity id", () => {
		const focused = focusEntityTimeline(world, "person_priya");
		const ids = focused.flatMap((d) => d.events.map((e) => e.entry.id));
		expect(ids).toEqual(["je_priya"]);
	});

	it("is empty when no JE references the entity", () => {
		expect(focusEntityTimeline(world, "person_nobody")).toEqual([]);
	});

	it("keeps the day-grouping shape of buildTimeline", () => {
		const focused = focusEntityTimeline(world, "proj_apiv2");
		expect(focused.map((d) => d.day)).toEqual(["2026-06-10"]);
		expect(focused[0]?.events[0]?.chips).toEqual([
			{ entityId: "proj_apiv2", kind: "project", title: "API v2" },
		]);
	});
});
