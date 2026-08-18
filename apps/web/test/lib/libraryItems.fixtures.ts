// Test-only Library fixtures — Core-shaped rows for exercising the pure helpers
// in libraryItems.ts. Not imported by app code (the live Library reads from Core
// via useLibraryItems); only *.test.ts files consume this. One coherent personal
// workspace mirroring CONTEXT.md's vocabulary, so the assertions read naturally.

import type { Person, Project } from "@/lib/libraryItems";

export const people: Person[] = [
	{
		id: "person_priya",
		kind: "person",
		name: "Priya Nair",
		note: "Owns the SDK examples. Flagged the dual-write rewrite risk on the contacts rename; prefers the /v2 alias path.",
		createdAt: "Today, 10:42",
		recency: 95,
	},
	{
		id: "person_alice",
		kind: "person",
		name: "Alice Whitman",
		aliases: ["Allie"],
		note: "Handling the daycare transition. Needs the updated schedule by Friday.",
		createdAt: "Today, 09:12",
		recency: 90,
	},
	{
		id: "person_marco",
		kind: "person",
		name: "Marco Reyes",
		note: "Quoted the garden retaining wall. Waiting on the revised estimate after the drainage change.",
		createdAt: "Yesterday",
		recency: 70,
	},
	{
		id: "person_dana",
		kind: "person",
		name: "Dana Osei",
		note: "Reviewing the Inkstone library surface. Likes the restrained pink direction; wants the empty states to teach.",
		createdAt: "May 28",
		recency: 50,
	},
	{
		id: "person_sam",
		kind: "person",
		name: "Sam Brennan",
		note: "Coming for dinner Saturday. Vegetarian, no mushrooms.",
		createdAt: "May 26",
		recency: 40,
	},
	{
		id: "person_lena",
		kind: "person",
		name: "Dr. Lena Fischer",
		note: "Six-month cleaning overdue. Office prefers Tuesday mornings.",
		createdAt: "May 20",
		recency: 30,
	},
];

export const projects: Project[] = [
	{
		id: "proj_apiv2",
		kind: "project",
		name: "API v2 migration",
		status: "active",
		outcome:
			"Rename /contacts → /v2/contacts behind a 90-day alias. Cutover the weekend after the backfill completes.",
		// Review overdue (before today 2026-06-12) — surfaces in the Review view.
		nextReviewAt: "2026-06-07T20:00:00",
		lastReviewedAt: "2026-05-31T20:00:00",
		createdAt: "Today, 10:42",
		recency: 92,
	},
	{
		id: "proj_inkstone",
		kind: "project",
		name: "Inkstone",
		status: "active",
		outcome:
			"Local-first thinking surface. Currently building the Library: a home for the knowledge chat accrues.",
		// Review in the future — not yet due.
		nextReviewAt: "2026-06-21T20:00:00",
		createdAt: "May 28",
		recency: 55,
	},
	{
		id: "proj_garden",
		kind: "project",
		name: "Garden rebuild",
		status: "on_hold",
		outcome:
			"Retaining wall plus a raised bed. On hold until Marco's revised estimate with the new drainage lands.",
		// On-hold and review overdue — surfaces in the Review view too.
		nextReviewAt: "2026-06-08T20:00:00",
		createdAt: "Yesterday",
		recency: 68,
	},
	{
		id: "proj_lisbon",
		kind: "project",
		name: "Lisbon trip",
		status: "active",
		outcome:
			"Five days in late June. Flights to book this week; loose plan to base in Alfama.",
		nextReviewAt: "2026-06-21T20:00:00",
		createdAt: "May 24",
		recency: 38,
	},
];

/** The whole fixture graph in one array (people + projects). */
export const libraryFixtures = [...people, ...projects];
