// Single source of truth for the mock agent-run scenario rendered by every design.
// Each design styles the same content very differently so they're directly comparable.

export type ProposalKind = "todo" | "project" | "note" | "file";

export type ChatTurn =
	| { role: "user"; t: string; text: string }
	| {
			role: "agent";
			t: string;
			text: string;
			// optional things the agent did during this turn
			actions?: { kind: "read" | "search" | "write" | "decide"; label: string }[];
			proposalIds?: string[];
	  };

// "Proposal" is now a misnomer — these are APPLIED edits the agent already made.
// The user reviews them post-hoc (audit), can undo, or open the target. The shape
// stays the same so existing routes still compile, but the semantics shifted.
export type Proposal = {
	id: string;
	kind: ProposalKind;
	title: string;
	target: string;
	summary: string;
	diff: { before?: string; after: string }[];
	confidence: number;
	appliedAt?: string; // when the edit landed, e.g. "10:42:25"
};

// A scheduled or recurring agent run — used by /4 Automations and /5 Inbox.
export type Automation = {
	id: string;
	name: string;
	prompt: string;
	schedule: string; // human label: "Mon–Fri 09:00", "Fri 17:00", "every Sun"
	cron: string; // e.g. "0 9 * * 1-5"
	enabled: boolean;
	lastRun?: { at: string; runId: string; edits: number; status: "ok" | "skipped" | "error" };
	nextRun?: string; // e.g. "tomorrow 09:00"
	createdAt: string;
};

// One automation run that produced edits or a summary.
export type AutomationRun = {
	id: string;
	automationId: string;
	at: string; // human time label
	durationMs: number;
	edits: number;
	summary: string;
	status: "ok" | "skipped" | "error";
};

export type FeedEvent = {
	t: string;
	kind: "thought" | "tool" | "read" | "write" | "decision";
	label: string;
	detail?: string;
};

export type RunHistoryItem = {
	id: string;
	when: string;
	prompt: string;
	status: "accepted" | "partial" | "rejected" | "running";
	changes: number;
};

export const currentRun = {
	id: "run_8e3a4f",
	startedAt: "10:42:08",
	elapsed: "00:01:14",
	status: "streaming" as "streaming" | "complete" | "error",
	prompt:
		"Read this morning's standup notes and turn the action items into todos under the Migration project. Draft a follow-up note for the API rename decision.",
	model: "local · gemma-3 27b",
	tokens: 4_812,
	streamed: [
		"Reading standup-2026-05-21.md from Daily Notes.",
		"Found 4 action items, 1 unresolved decision (API rename → /v2/contacts).",
		"Cross-referencing with the Migration project — 2 of 4 already exist as open todos; skipping duplicates.",
		"Added two todos under Migration and a decision note for the API rename. Done.",
	],
};

export const feed: FeedEvent[] = [
	{
		t: "10:42:08",
		kind: "thought",
		label: "Plan",
		detail: "Parse standup → extract action items → diff against Migration project",
	},
	{ t: "10:42:09", kind: "read", label: "Read", detail: "daily/standup-2026-05-21.md" },
	{ t: "10:42:11", kind: "read", label: "Read", detail: "projects/migration.md" },
	{
		t: "10:42:14",
		kind: "tool",
		label: "Search",
		detail: "‘API rename’ across 312 notes → 6 hits",
	},
	{
		t: "10:42:18",
		kind: "decision",
		label: "Skip",
		detail: "Duplicate todo: ‘set up staging keys’ (created 3d ago)",
	},
	{
		t: "10:42:22",
		kind: "decision",
		label: "Skip",
		detail: "Duplicate todo: ‘email Priya re: cutover window’",
	},
	{ t: "10:42:25", kind: "write", label: "Draft", detail: "todo · backfill /v2/contacts" },
	{ t: "10:42:27", kind: "write", label: "Draft", detail: "todo · update SDK examples" },
	{ t: "10:42:29", kind: "write", label: "Draft", detail: "note · API rename decision" },
];

export const proposals: Proposal[] = [
	{
		id: "p_todo_1",
		kind: "todo",
		title: "Backfill /v2/contacts before cutover",
		target: "Migration · todos",
		summary:
			"From standup: ‘need to backfill the new contacts endpoint over the weekend, ~2.3M rows’. No existing todo matched.",
		diff: [
			{
				after:
					"- [ ] Backfill /v2/contacts (~2.3M rows) before the cutover window. Owner: @hongyi. Due Sat.",
			},
		],
		confidence: 0.94,
		appliedAt: "10:42:25",
	},
	{
		id: "p_todo_2",
		kind: "todo",
		title: "Update SDK examples for renamed endpoint",
		target: "Migration · todos",
		summary:
			"Action item from Priya. The four SDK readmes still reference /contacts; cutover blocks on this.",
		diff: [
			{
				after:
					"- [ ] Update SDK examples (ts, py, go, rb) to use /v2/contacts. Owner: @priya. Due Mon.",
			},
		],
		confidence: 0.88,
		appliedAt: "10:42:27",
	},
	{
		id: "p_note_1",
		kind: "note",
		title: "Decision: rename /contacts → /v2/contacts",
		target: "decisions/2026-05-21-api-rename.md",
		summary:
			"New decision note capturing what was settled in standup, with links back to the three prior threads.",
		diff: [
			{
				after:
					"# Decision · API rename\n\n**Date** 2026-05-21  **Owner** @hongyi\n\nWe will ship the rename behind /v2 and keep /contacts as a 90-day alias. Cutover window is the weekend after backfill completes.\n\n**Why** Avoids the dual-write rewrite Priya flagged. Aliases give SDK consumers one release cycle of overlap.",
			},
		],
		confidence: 0.81,
		appliedAt: "10:42:29",
	},
	{
		id: "p_proj_1",
		kind: "project",
		title: "Migration · move to ‘In review’",
		target: "Migration project",
		summary:
			"Three of four blockers are now open todos with owners. Status field is stale at ‘Planning’.",
		diff: [
			{ before: "status: planning", after: "status: in-review" },
			{ before: "blockers: 4", after: "blockers: 1" },
		],
		confidence: 0.72,
		appliedAt: "10:42:31",
	},
];

export const history: RunHistoryItem[] = [
	{
		id: "run_8e3a4f",
		when: "now",
		prompt: "Turn standup action items into todos…",
		status: "running",
		changes: 4,
	},
	{
		id: "run_8e2c91",
		when: "yesterday, 17:04",
		prompt: "Summarize the week into a Friday digest",
		status: "accepted",
		changes: 1,
	},
	{
		id: "run_8e1b7d",
		when: "yesterday, 09:11",
		prompt: "Find every TODO in projects/* and group by owner",
		status: "partial",
		changes: 6,
	},
	{
		id: "run_8e09ee",
		when: "Tue, 14:40",
		prompt: "Rewrite the API rename RFC for clarity",
		status: "rejected",
		changes: 0,
	},
	{
		id: "run_8df4a2",
		when: "Mon, 22:18",
		prompt: "Draft retrospective from /retros/2026-q1.md",
		status: "accepted",
		changes: 3,
	},
	{
		id: "run_8dc017",
		when: "Sun, 11:02",
		prompt: "Reorganize Inbox into projects",
		status: "accepted",
		changes: 12,
	},
];

export const workspace = {
	name: "hongyi.workspace",
	path: "~/notes",
	connection: "local · sandboxed",
	sync: "up to date",
	model: "gemma-3 27b · ollama",
	notes: 312,
	projects: 14,
};

// Multi-turn conversation. The latest agent turn streams in (its `text` is built up
// progressively in the UI). Earlier turns are static history within the same thread.
// Designs render this as bubbles, terminal lines, prose, etc.
export const conversation: ChatTurn[] = [
	{
		role: "user",
		t: "10:38",
		text: "Morning. What did standup land on for the API rename?",
	},
	{
		role: "agent",
		t: "10:38",
		text:
			"From standup-2026-05-21.md: the team agreed to ship the rename as /v2/contacts behind a 90-day alias for /contacts. Cutover is the weekend after the backfill finishes. Priya raised one open thread — SDK examples still reference the old path.",
		actions: [
			{ kind: "read", label: "daily/standup-2026-05-21.md" },
			{ kind: "search", label: "‘API rename’ across 312 notes" },
		],
	},
];

export const automations: Automation[] = [
	{
		id: "auto_digest",
		name: "Friday digest",
		prompt:
			"Pull together this week's closed todos, decisions, and unresolved threads into a Friday digest under /digests/.",
		schedule: "Fri 17:00",
		cron: "0 17 * * 5",
		enabled: true,
		lastRun: { at: "Fri 17:00", runId: "run_a_digest_3", edits: 1, status: "ok" },
		nextRun: "Fri 17:00",
		createdAt: "3 weeks ago",
	},
	{
		id: "auto_standup",
		name: "Standup reader",
		prompt:
			"Read this morning's standup notes and turn the action items into todos under the Migration project.",
		schedule: "Mon–Fri 09:30",
		cron: "30 9 * * 1-5",
		enabled: true,
		lastRun: { at: "today 09:30", runId: "run_a_standup_12", edits: 3, status: "ok" },
		nextRun: "tomorrow 09:30",
		createdAt: "2 months ago",
	},
	{
		id: "auto_inbox",
		name: "Inbox sweeper",
		prompt:
			"Sort anything in /inbox older than 24h into the right project folder. Skip if uncertain.",
		schedule: "every 6h",
		cron: "0 */6 * * *",
		enabled: true,
		lastRun: { at: "06:00 today", runId: "run_a_inbox_88", edits: 5, status: "ok" },
		nextRun: "in 2h",
		createdAt: "5 weeks ago",
	},
	{
		id: "auto_retro",
		name: "Quarterly retro draft",
		prompt:
			"Draft a quarterly retrospective from /retros/. Pull stats, themes, and unresolved threads.",
		schedule: "1st of quarter",
		cron: "0 10 1 1,4,7,10 *",
		enabled: false,
		lastRun: { at: "April 1", runId: "run_a_retro_1", edits: 1, status: "ok" },
		createdAt: "6 months ago",
	},
	{
		id: "auto_dupes",
		name: "Duplicate todo cleanup",
		prompt:
			"Find duplicate todos across all projects and merge them, keeping the earliest. Show me what you merged.",
		schedule: "every Sun 22:00",
		cron: "0 22 * * 0",
		enabled: true,
		lastRun: {
			at: "Sun 22:00",
			runId: "run_a_dupes_4",
			edits: 0,
			status: "skipped",
		},
		nextRun: "Sun 22:00",
		createdAt: "1 month ago",
	},
];

export const automationRuns: AutomationRun[] = [
	{
		id: "run_a_standup_12",
		automationId: "auto_standup",
		at: "today 09:30",
		durationMs: 14_200,
		edits: 3,
		summary:
			"3 todos added under Migration. Skipped 1 duplicate (‘set up staging keys’).",
		status: "ok",
	},
	{
		id: "run_a_inbox_88",
		automationId: "auto_inbox",
		at: "today 06:00",
		durationMs: 8_900,
		edits: 5,
		summary: "Moved 5 notes out of /inbox — 3 to Migration, 2 to /retros.",
		status: "ok",
	},
	{
		id: "run_a_digest_3",
		automationId: "auto_digest",
		at: "Fri 17:00",
		durationMs: 21_400,
		edits: 1,
		summary: "Drafted week-of-2026-05-15 digest. 12 todos closed, 4 decisions.",
		status: "ok",
	},
	{
		id: "run_a_dupes_4",
		automationId: "auto_dupes",
		at: "Sun 22:00",
		durationMs: 3_300,
		edits: 0,
		summary: "No duplicates found across 312 notes. Skipped.",
		status: "skipped",
	},
	{
		id: "run_a_standup_11",
		automationId: "auto_standup",
		at: "yesterday 09:30",
		durationMs: 12_800,
		edits: 2,
		summary: "2 todos added under Migration.",
		status: "ok",
	},
	{
		id: "run_a_inbox_87",
		automationId: "auto_inbox",
		at: "yesterday 18:00",
		durationMs: 6_100,
		edits: 2,
		summary: "Moved 2 notes — both to Migration.",
		status: "ok",
	},
	{
		id: "run_a_retro_1",
		automationId: "auto_retro",
		at: "April 1, 10:00",
		durationMs: 41_500,
		edits: 1,
		summary: "Drafted Q1 retrospective. 38 todos closed, 9 decisions, 2 incidents.",
		status: "ok",
	},
];

// One step inside an automation thread waterfall. No user turns — this is a cron
// run, fully autonomous. Steps are chronological and immutable.
export type AutomationStep =
	| { kind: "thought"; t: string; text: string }
	| { kind: "read"; t: string; label: string; detail?: string }
	| { kind: "search"; t: string; label: string; detail?: string }
	| { kind: "decide"; t: string; label: string; detail?: string }
	| { kind: "edit"; t: string; proposalId: string }
	| { kind: "summary"; t: string; text: string };

// The full waterfall for `auto_standup` run "run_a_standup_12" today at 09:30.
// /6 renders this as a single autonomous-thread page.
export const automationThread = {
	runId: "run_a_standup_12",
	automationId: "auto_standup",
	automationName: "Standup reader",
	startedAt: "today 09:30:00",
	finishedAt: "today 09:30:14",
	durationMs: 14_200,
	prompt:
		"Read this morning's standup notes and turn the action items into todos under the Migration project.",
	tokens: 3_840,
	model: "gemma-3 27b · ollama",
	status: "ok" as const,
	steps: [
		{
			kind: "thought" as const,
			t: "09:30:00",
			text: "Plan: parse standup → extract action items → diff against Migration project.",
		},
		{
			kind: "read" as const,
			t: "09:30:01",
			label: "daily/standup-2026-05-21.md",
			detail: "312 lines",
		},
		{
			kind: "read" as const,
			t: "09:30:03",
			label: "projects/migration.md",
			detail: "open todos: 14",
		},
		{
			kind: "search" as const,
			t: "09:30:05",
			label: "‘API rename’",
			detail: "6 hits across 312 notes",
		},
		{
			kind: "decide" as const,
			t: "09:30:08",
			label: "skip duplicate",
			detail: "‘set up staging keys’ already exists (created 3d ago)",
		},
		{
			kind: "edit" as const,
			t: "09:30:10",
			proposalId: "p_todo_1",
		},
		{
			kind: "edit" as const,
			t: "09:30:11",
			proposalId: "p_todo_2",
		},
		{
			kind: "edit" as const,
			t: "09:30:13",
			proposalId: "p_note_1",
		},
		{
			kind: "summary" as const,
			t: "09:30:14",
			text: "3 edits applied under Migration. Skipped 1 duplicate. Next run tomorrow 09:30.",
		},
	] satisfies AutomationStep[],
};

export type QueueKind = "question" | "approval";
export type QueueItem = {
	id: string;
	kind: QueueKind;
	resolveProposalId: string;
	pendingGlyph: string;
	pendingTitle: string;
};
export const queue: QueueItem[] = [
	{
		id: "q_inbox",
		kind: "question",
		resolveProposalId: "p_note_1",
		pendingGlyph: "?",
		pendingTitle: "Inbox sweeper · pick aggressiveness",
	},
	{
		id: "q_migration",
		kind: "approval",
		resolveProposalId: "p_proj_1",
		pendingGlyph: "✱",
		pendingTitle: "Approve change to projects/migration.md",
	},
];

export type Model = {
	id: string;
	provider: "local" | "anthropic" | "openai";
	name: string;
	description: string;
};

export const models: Model[] = [
	{
		id: "gemma-3-27b",
		provider: "local",
		name: "gemma-3 27b",
		description: "local · ollama",
	},
	{
		id: "llama-3.3-70b",
		provider: "local",
		name: "llama-3.3 70b",
		description: "local · ollama",
	},
	{
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		name: "Claude Sonnet 4.6",
		description: "anthropic · cloud",
	},
	{
		id: "claude-opus-4-7",
		provider: "anthropic",
		name: "Claude Opus 4.7",
		description: "anthropic · cloud",
	},
	{
		id: "gpt-5",
		provider: "openai",
		name: "GPT-5",
		description: "openai · cloud",
	},
];
