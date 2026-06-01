// Types shared by every mock slice. Kept here so feature files import types
// without pulling in unrelated data.

export type ProposalKind = "todo" | "project" | "note" | "file";

// Flat mock view of a chat message. NOTE: this shape is wrong vs ADR-0017 —
// it collapses into one record what the tier-2 schema splits across
// messages / message_parts / tool_calls / run_steps / proposals. It's a
// stand-in for the design routes and is slated to be replaced by the live
// `Message` type.
export type MockChatMessage =
	| { role: "user"; t: string; text: string }
	| {
			role: "assistant";
			t: string;
			text: string;
			// optional things the assistant did during this message
			actions?: {
				kind: "read" | "search" | "write" | "decide";
				label: string;
			}[];
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
	lastRun?: {
		at: string;
		runId: string;
		edits: number;
		status: "ok" | "skipped" | "error";
	};
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

// One step inside an automation thread waterfall. No user turns — this is a cron
// run, fully autonomous. Steps are chronological and immutable.
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

export type ModelCapability = "vision" | "reasoning" | "files";
export type ModelTier = "$" | "$$" | "$$$";
export type ModelProvider =
	| "openai"
	| "anthropic"
	| "google"
	| "meta"
	| "deepseek"
	| "moonshot"
	| "local";
export type Model = {
	id: string;
	provider: ModelProvider;
	name: string;
	description: string;
	tier: ModelTier;
	capabilities: ModelCapability[];
	favorite?: boolean;
};
