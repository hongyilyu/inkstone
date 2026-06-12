import type { Automation, AutomationRun, AutomationStep } from "./types.js";

export const automations: Automation[] = [
	{
		id: "auto_digest",
		name: "Friday digest",
		prompt:
			"Pull together this week's closed todos, decisions, and unresolved threads into a Friday digest under /digests/.",
		schedule: "Fri 17:00",
		cron: "0 17 * * 5",
		enabled: true,
		lastRun: {
			at: "Fri 17:00",
			runId: "run_a_digest_3",
			edits: 1,
			status: "ok",
		},
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
		lastRun: {
			at: "today 09:30",
			runId: "run_a_standup_12",
			edits: 3,
			status: "ok",
		},
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
		lastRun: {
			at: "06:00 today",
			runId: "run_a_inbox_88",
			edits: 5,
			status: "ok",
		},
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
		summary:
			"Drafted Q1 retrospective. 38 todos closed, 9 decisions, 2 incidents.",
		status: "ok",
	},
];

/** Full step waterfall for the `auto_standup` run "run_a_standup_12", rendered by /6 as an autonomous-thread page. */
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
