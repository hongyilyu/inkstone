// Mock Accepted Entities (CONTEXT.md domain: Journal Entry / Person / Project / Todo / Recipe).
//
// VISUAL ONLY for entity types not read live from Core yet. The Library hook
// overlays live Core rows for implemented types and keeps this fixture for the
// rest, mirroring how ActivityRail renders from mock data. The shapes follow
// CONTEXT.md vocabulary so the future live wiring maps cleanly; the data is one
// coherent personal workspace (the account is "H" — Hongyi) and deliberately
// overlaps the API-migration project already referenced in `proposals.ts` and
// the Alice / daycare example from CONTEXT.md's dialogue.

export type EntityKind =
	| "journal_entry"
	| "person"
	| "project"
	| "todo"
	| "recipe";

/** Where an Entity was captured from — the Run that proposed it (CONTEXT.md). */
export interface EntitySource {
	threadId: string;
	threadTitle: string;
	when: string;
}

interface EntityBase {
	id: string;
	kind: EntityKind;
	/** Human label for when it was accepted, e.g. "Today, 10:42" or "May 21". */
	createdAt: string;
	/** Higher = more recently captured. Drives "Recently captured" ordering. */
	recency: number;
	/** Accepted but not yet confirmed by the user — surfaces in "Needs review". */
	needsReview?: boolean;
	source?: EntitySource;
}

export interface Person extends EntityBase {
	kind: "person";
	name: string;
	role?: string;
	relationship?: string;
	email?: string;
	note?: string;
	projectIds?: string[];
}

export interface JournalEntry extends EntityBase {
	kind: "journal_entry";
	occurredAt: string;
	body: string;
}

export type ProjectStatus = "active" | "review" | "paused" | "done";

export interface Project extends EntityBase {
	kind: "project";
	name: string;
	status: ProjectStatus;
	summary?: string;
	personIds?: string[];
	todoIds?: string[];
}

export interface Todo extends EntityBase {
	kind: "todo";
	title: string;
	done: boolean;
	/** Human due label, e.g. "Today", "Fri", "May 30". Undefined = no due date. */
	due?: string;
	/** Days from today: negative = overdue, 0 = today, positive = upcoming. */
	dueInDays?: number;
	projectId?: string;
	owner?: string;
	note?: string;
}

export interface Recipe extends EntityBase {
	kind: "recipe";
	title: string;
	tags?: string[];
	time?: string;
	servings?: number;
	ingredients: string[];
	steps?: string[];
}

export type Entity = JournalEntry | Person | Project | Todo | Recipe;

// --- people -----------------------------------------------------------------

export const people: Person[] = [
	{
		id: "person_priya",
		kind: "person",
		name: "Priya Nair",
		role: "Staff engineer, Platform",
		relationship: "Colleague",
		email: "priya@acme.dev",
		note: "Owns the SDK examples. Flagged the dual-write rewrite risk on the contacts rename; prefers the /v2 alias path.",
		projectIds: ["proj_apiv2"],
		createdAt: "Today, 10:42",
		recency: 95,
		needsReview: true,
		source: {
			threadId: "th_standup",
			threadTitle: "Migration standup notes",
			when: "Today, 10:41",
		},
	},
	{
		id: "person_alice",
		kind: "person",
		name: "Alice Whitman",
		role: "Daycare coordinator",
		relationship: "Family logistics",
		note: "Handling the daycare transition. Needs the updated schedule by Friday.",
		createdAt: "Today, 09:12",
		recency: 90,
		needsReview: true,
		source: {
			threadId: "th_daycare",
			threadTitle: "Daycare transition",
			when: "Today, 09:12",
		},
	},
	{
		id: "person_marco",
		kind: "person",
		name: "Marco Reyes",
		role: "General contractor",
		relationship: "Home",
		email: "marco@reyesbuild.co",
		note: "Quoted the garden retaining wall. Waiting on the revised estimate after the drainage change.",
		projectIds: ["proj_garden"],
		createdAt: "Yesterday",
		recency: 70,
		source: {
			threadId: "th_garden",
			threadTitle: "Garden rebuild planning",
			when: "Yesterday, 18:30",
		},
	},
	{
		id: "person_dana",
		kind: "person",
		name: "Dana Osei",
		role: "Design lead",
		relationship: "Colleague",
		email: "dana@acme.dev",
		note: "Reviewing the Inkstone library surface. Likes the restrained pink direction; wants the empty states to teach.",
		projectIds: ["proj_inkstone"],
		createdAt: "May 28",
		recency: 50,
		source: {
			threadId: "th_inkstone_ux",
			threadTitle: "Library UX review",
			when: "May 28, 14:05",
		},
	},
	{
		id: "person_sam",
		kind: "person",
		name: "Sam Brennan",
		relationship: "Friend",
		note: "Coming for dinner Saturday. Vegetarian, no mushrooms.",
		createdAt: "May 26",
		recency: 40,
		source: {
			threadId: "th_dinner",
			threadTitle: "Saturday dinner plan",
			when: "May 26, 20:10",
		},
	},
	{
		id: "person_lena",
		kind: "person",
		name: "Dr. Lena Fischer",
		role: "Dentist",
		relationship: "Health",
		note: "Six-month cleaning overdue. Office prefers Tuesday mornings.",
		createdAt: "May 20",
		recency: 30,
		source: {
			threadId: "th_health",
			threadTitle: "Health admin",
			when: "May 20, 08:40",
		},
	},
];

// --- projects ---------------------------------------------------------------

export const projects: Project[] = [
	{
		id: "proj_apiv2",
		kind: "project",
		name: "API v2 migration",
		status: "review",
		summary:
			"Rename /contacts → /v2/contacts behind a 90-day alias. Cutover the weekend after the backfill completes.",
		personIds: ["person_priya"],
		todoIds: ["todo_backfill", "todo_sdk", "todo_cutover"],
		createdAt: "Today, 10:42",
		recency: 92,
		source: {
			threadId: "th_standup",
			threadTitle: "Migration standup notes",
			when: "Today, 10:42",
		},
	},
	{
		id: "proj_inkstone",
		kind: "project",
		name: "Inkstone",
		status: "active",
		summary:
			"Local-first thinking surface. Currently building the Library: a home for the knowledge chat accrues.",
		personIds: ["person_dana"],
		todoIds: ["todo_library", "todo_empty_states"],
		createdAt: "May 28",
		recency: 55,
		source: {
			threadId: "th_inkstone_ux",
			threadTitle: "Library UX review",
			when: "May 28, 14:05",
		},
	},
	{
		id: "proj_garden",
		kind: "project",
		name: "Garden rebuild",
		status: "paused",
		summary:
			"Retaining wall plus a raised bed. Paused until Marco's revised estimate with the new drainage lands.",
		personIds: ["person_marco"],
		todoIds: ["todo_estimate"],
		createdAt: "Yesterday",
		recency: 68,
		source: {
			threadId: "th_garden",
			threadTitle: "Garden rebuild planning",
			when: "Yesterday, 18:30",
		},
	},
	{
		id: "proj_lisbon",
		kind: "project",
		name: "Lisbon trip",
		status: "active",
		summary:
			"Five days in late June. Flights to book this week; loose plan to base in Alfama.",
		todoIds: ["todo_flights"],
		createdAt: "May 24",
		recency: 38,
		source: {
			threadId: "th_lisbon",
			threadTitle: "Lisbon planning",
			when: "May 24, 21:15",
		},
	},
];

// --- todos ------------------------------------------------------------------

export const todos: Todo[] = [
	{
		id: "todo_backfill",
		kind: "todo",
		title: "Backfill /v2/contacts before the cutover window",
		done: false,
		due: "Today",
		dueInDays: 0,
		projectId: "proj_apiv2",
		owner: "Hongyi",
		note: "~2.3M rows. Blocks the weekend cutover.",
		createdAt: "Today, 10:42",
		recency: 94,
		needsReview: true,
		source: {
			threadId: "th_standup",
			threadTitle: "Migration standup notes",
			when: "Today, 10:42",
		},
	},
	{
		id: "todo_schedule_alice",
		kind: "todo",
		title: "Send Alice the updated daycare schedule",
		done: false,
		due: "Fri",
		dueInDays: 2,
		owner: "Hongyi",
		createdAt: "Today, 09:12",
		recency: 89,
		source: {
			threadId: "th_daycare",
			threadTitle: "Daycare transition",
			when: "Today, 09:12",
		},
	},
	{
		id: "todo_sdk",
		kind: "todo",
		title: "Update SDK examples (ts, py, go, rb) to /v2/contacts",
		done: false,
		due: "Mon",
		dueInDays: 5,
		projectId: "proj_apiv2",
		owner: "Priya",
		createdAt: "Today, 10:42",
		recency: 88,
		source: {
			threadId: "th_standup",
			threadTitle: "Migration standup notes",
			when: "Today, 10:42",
		},
	},
	{
		id: "todo_dentist",
		kind: "todo",
		title: "Book the overdue dental cleaning",
		done: false,
		due: "May 30",
		dueInDays: -1,
		createdAt: "May 20",
		recency: 31,
		note: "Tuesday mornings preferred.",
		source: {
			threadId: "th_health",
			threadTitle: "Health admin",
			when: "May 20, 08:40",
		},
	},
	{
		id: "todo_flights",
		kind: "todo",
		title: "Book Lisbon flights",
		done: false,
		due: "Thu",
		dueInDays: 1,
		projectId: "proj_lisbon",
		createdAt: "May 24",
		recency: 37,
		source: {
			threadId: "th_lisbon",
			threadTitle: "Lisbon planning",
			when: "May 24, 21:15",
		},
	},
	{
		id: "todo_estimate",
		kind: "todo",
		title: "Chase Marco for the revised wall estimate",
		done: false,
		due: "next week",
		dueInDays: 7,
		projectId: "proj_garden",
		createdAt: "Yesterday",
		recency: 66,
		source: {
			threadId: "th_garden",
			threadTitle: "Garden rebuild planning",
			when: "Yesterday, 18:30",
		},
	},
	{
		id: "todo_library",
		kind: "todo",
		title: "Ship the Library surface",
		done: false,
		projectId: "proj_inkstone",
		createdAt: "May 28",
		recency: 54,
		source: {
			threadId: "th_inkstone_ux",
			threadTitle: "Library UX review",
			when: "May 28, 14:05",
		},
	},
	{
		id: "todo_groceries",
		kind: "todo",
		title: "Groceries for Saturday dinner",
		done: false,
		due: "Sat",
		dueInDays: 3,
		createdAt: "May 26",
		recency: 41,
		note: "Sam is vegetarian, no mushrooms.",
		source: {
			threadId: "th_dinner",
			threadTitle: "Saturday dinner plan",
			when: "May 26, 20:10",
		},
	},
	{
		id: "todo_cutover",
		kind: "todo",
		title: "Schedule the cutover window with on-call",
		done: true,
		projectId: "proj_apiv2",
		createdAt: "Today, 10:43",
		recency: 86,
		source: {
			threadId: "th_standup",
			threadTitle: "Migration standup notes",
			when: "Today, 10:43",
		},
	},
	{
		id: "todo_empty_states",
		kind: "todo",
		title: "Design the Library empty + first-run states",
		done: true,
		projectId: "proj_inkstone",
		createdAt: "May 28",
		recency: 52,
		source: {
			threadId: "th_inkstone_ux",
			threadTitle: "Library UX review",
			when: "May 28, 14:05",
		},
	},
	{
		id: "todo_passport",
		kind: "todo",
		title: "Check passport expiry for Lisbon",
		done: true,
		projectId: "proj_lisbon",
		createdAt: "May 24",
		recency: 36,
		source: {
			threadId: "th_lisbon",
			threadTitle: "Lisbon planning",
			when: "May 24, 21:16",
		},
	},
];

// --- recipes ----------------------------------------------------------------

export const recipes: Recipe[] = [
	{
		id: "recipe_ragu",
		kind: "recipe",
		title: "Weeknight ragù",
		tags: ["pasta", "make-ahead"],
		time: "45 min",
		servings: 4,
		ingredients: [
			"500g ground beef and pork",
			"1 onion, 1 carrot, 1 celery stalk, finely diced",
			"200ml whole milk",
			"400ml passata",
			"Parmesan rind",
		],
		steps: [
			"Soffritto low and slow until sweet, ~12 min.",
			"Brown the meat hard, then deglaze with milk.",
			"Add passata and the rind; simmer 30 min.",
		],
		createdAt: "May 26",
		recency: 42,
		source: {
			threadId: "th_dinner",
			threadTitle: "Saturday dinner plan",
			when: "May 26, 20:12",
		},
	},
	{
		id: "recipe_salmon",
		kind: "recipe",
		title: "Miso-glazed salmon",
		tags: ["fish", "fast"],
		time: "20 min",
		servings: 2,
		ingredients: [
			"2 salmon fillets",
			"2 tbsp white miso",
			"1 tbsp mirin",
			"1 tbsp maple syrup",
		],
		steps: [
			"Whisk miso, mirin, maple.",
			"Glaze the fillets; broil 8 min until caramelized.",
		],
		createdAt: "May 22",
		recency: 34,
		source: {
			threadId: "th_dinner",
			threadTitle: "Weeknight dinners",
			when: "May 22, 19:30",
		},
	},
	{
		id: "recipe_sourdough",
		kind: "recipe",
		title: "Everyday sourdough",
		tags: ["bread", "weekend"],
		time: "24 hr",
		servings: 1,
		ingredients: [
			"500g bread flour",
			"350g water",
			"100g active starter",
			"10g salt",
		],
		steps: [
			"Autolyse 1 hr.",
			"Stretch and fold every 30 min, 4 sets.",
			"Cold proof overnight; bake at 250°C in a Dutch oven.",
		],
		createdAt: "May 18",
		recency: 28,
		needsReview: true,
		source: {
			threadId: "th_baking",
			threadTitle: "Sourdough notes",
			when: "May 18, 09:00",
		},
	},
	{
		id: "recipe_pancakes",
		kind: "recipe",
		title: "Sunday buttermilk pancakes",
		tags: ["breakfast"],
		time: "25 min",
		servings: 3,
		ingredients: [
			"200g flour",
			"300ml buttermilk",
			"1 egg",
			"1 tsp baking soda",
		],
		steps: ["Whisk wet and dry separately.", "Fold; rest 10 min; griddle."],
		createdAt: "May 11",
		recency: 18,
		source: {
			threadId: "th_breakfast",
			threadTitle: "Weekend breakfasts",
			when: "May 11, 08:30",
		},
	},
	{
		id: "recipe_negroni",
		kind: "recipe",
		title: "House negroni",
		tags: ["drinks"],
		time: "5 min",
		servings: 1,
		ingredients: [
			"30ml gin",
			"30ml Campari",
			"30ml sweet vermouth",
			"Orange peel",
		],
		steps: ["Stir over ice 20 turns.", "Strain over a big cube; express peel."],
		createdAt: "May 9",
		recency: 12,
		source: {
			threadId: "th_dinner",
			threadTitle: "Saturday dinner plan",
			when: "May 9, 21:00",
		},
	},
];

/** All entities in one array (stable identity for the query layer). */
export const entities: Entity[] = [
	...people,
	...projects,
	...todos,
	...recipes,
];
