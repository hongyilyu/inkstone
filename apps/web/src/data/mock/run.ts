import type { FeedEvent } from "./types.js";

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
		detail:
			"Parse standup → extract action items → diff against Migration project",
	},
	{
		t: "10:42:09",
		kind: "read",
		label: "Read",
		detail: "daily/standup-2026-05-21.md",
	},
	{
		t: "10:42:11",
		kind: "read",
		label: "Read",
		detail: "projects/migration.md",
	},
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
	{
		t: "10:42:25",
		kind: "write",
		label: "Draft",
		detail: "todo · backfill /v2/contacts",
	},
	{
		t: "10:42:27",
		kind: "write",
		label: "Draft",
		detail: "todo · update SDK examples",
	},
	{
		t: "10:42:29",
		kind: "write",
		label: "Draft",
		detail: "note · API rename decision",
	},
];
