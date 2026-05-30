import type { QueueItem } from "./types.js";

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
