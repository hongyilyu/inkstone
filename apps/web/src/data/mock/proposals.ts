import type { Proposal } from "./types.js";

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
