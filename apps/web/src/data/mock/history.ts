import type { RunHistoryItem } from "./types.js";

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
