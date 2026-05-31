import type { ChatTurn } from "./types.js";

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
		text: "From standup-2026-05-21.md: the team agreed to ship the rename as /v2/contacts behind a 90-day alias for /contacts. Cutover is the weekend after the backfill finishes. Priya raised one open thread — SDK examples still reference the old path.",
		actions: [
			{ kind: "read", label: "daily/standup-2026-05-21.md" },
			{ kind: "search", label: "‘API rename’ across 312 notes" },
		],
	},
];
