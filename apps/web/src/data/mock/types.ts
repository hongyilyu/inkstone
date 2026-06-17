// Types shared by every mock slice, kept separate so feature files import types without unrelated data.

export type ProposalKind = "todo" | "project" | "note" | "file";

/** Flat mock view of a chat message; stand-in for the live `Message` type (collapses ADR-0017 tier-2 schema into one record). */
export type MockChatMessage =
	| { role: "user"; t: string; text: string }
	| {
			role: "assistant";
			t: string;
			text: string;
			actions?: {
				kind: "read" | "search" | "write" | "decide";
				label: string;
			}[];
			proposalIds?: string[];
	  };

/** An APPLIED edit the agent already made, reviewed post-hoc (audit/undo/open) — despite the legacy "Proposal" name. */
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

/** A scheduled or recurring agent run, used by /4 Automations and /5 Inbox. */
export type Automation = {
	id: string;
	name: string;
	prompt: string;
	schedule: string; // human label: "Mon–Fri 09:00", "Fri 17:00", "every Sun"
	cron: string; // e.g. "0 9 * * 1-5"
	enabled: boolean;
	lastRun?: {
		at: string;
		runId: string;
		edits: number;
		status: "ok" | "skipped" | "error";
	};
	nextRun?: string; // e.g. "tomorrow 09:00"
	createdAt: string;
};

/** One automation run that produced edits or a summary. */
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

/** One chronological, immutable step inside an automation thread waterfall (no user turns — fully autonomous cron run). */
export type AutomationStep =
	| { kind: "thought"; t: string; text: string }
	| { kind: "read"; t: string; label: string; detail?: string }
	| { kind: "search"; t: string; label: string; detail?: string }
	| { kind: "decide"; t: string; label: string; detail?: string }
	| { kind: "edit"; t: string; proposalId: string }
	| { kind: "summary"; t: string; text: string };

export type QueueKind = "question" | "approval";
export type QueueItem = {
	id: string;
	kind: QueueKind;
	resolveProposalId: string;
	pendingGlyph: string;
	pendingTitle: string;
};
