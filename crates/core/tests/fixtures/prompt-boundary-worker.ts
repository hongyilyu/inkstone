// Deterministic semantic-boundary Worker fixture for e2e tests.
//
// It reads the real Workflow prompt Core sends in the WorkerManifest. For the
// reminder-shaped test message, it emits a bad Journal proposal if the shipped
// prompt no longer contains the reminder/task exclusion. Otherwise it answers
// normally. This keeps the e2e guard at the same boundary the model sees while
// avoiding nondeterministic real-model assertions in CI.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emit, stdinLines } from "./transport.js";

// The shipped Workflow whose prompt the boundary guards assert against. It lives
// two dirs up from this fixture (crates/core/workflows/default.toml) — the SAME
// file Core loads at boot and `workflow_load.rs` reads. Resolving from the
// fixture's own URL keeps the e2e prompt assertion pinned to the real shipped
// prompt with no Core spawn (a fast, browser-less guard, like hasReminderBoundary).
const SHIPPED_WORKFLOW_URL = new URL(
	"../../workflows/default.toml",
	import.meta.url,
);

/**
 * Extract the shipped `default.toml`'s `system_prompt` (a TOML triple-quoted
 * string) without a TOML dependency. A regex on the `system_prompt = """…"""`
 * block is sufficient for this single, well-formed shipped file.
 */
export function readShippedSystemPrompt(): string {
	const raw = readFileSync(fileURLToPath(SHIPPED_WORKFLOW_URL), "utf8");
	const match = raw.match(/system_prompt\s*=\s*"""\r?\n([\s\S]*?)"""/);
	if (match === null) {
		throw new Error("shipped default.toml has no triple-quoted system_prompt");
	}
	return match[1];
}

/** The manifest fields this fixture reads (Core writes the full WorkerManifest). */
type PromptManifest = {
	prompt?: string;
	workflow?: { system_prompt?: string };
};

const BAD_REMINDER_PROPOSAL = {
	mutation_kind: "create_journal_entry",
	payload: {
		occurred_at: "2026-06-10T10:30:00",
		body: [
			{ type: "text", text: "Remember to buy milk after daycare pickup." },
		],
	},
	rationale: "Save the user's reminder as a journal entry.",
};

// Keep these exact phrases in sync with the shipped prompt. The fixture should
// fail if the model-visible boundary is softened by wording drift.
//
// The boundary MOVED at the ticktick-writes cutover (ADR-0065 amending
// ADR-0064): a reminder/task still never becomes a Journal Entry, but it is no
// longer a dead-end redirect — it becomes exactly ONE `propose_ticktick_task`
// Proposal, and no OTHER Workspace mutation. The guard therefore requires (a)
// the Journal-Entry exclusion, (b) the named write tool, (c) the never-another-
// mutation clause, and (d) that the model still cannot complete/edit/delete a
// task. It deliberately REJECTS both the retired "add it in TickTick yourself"
// dead-end and any softened wording that drops the tool name.
export function hasReminderBoundary(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	return (
		lower.includes("do not propose a journal entry") &&
		lower.includes("reminders") &&
		lower.includes("tasks") &&
		lower.includes("ticktick is the user's task system") &&
		lower.includes("propose_ticktick_task") &&
		lower.includes("never a journal entry") &&
		lower.includes("cannot complete, edit, or delete") &&
		// The retired dead-end must be GONE: "tell them to add it in TickTick"
		// with no proposal is exactly the capability ADR-0065 restores.
		!lower.includes("add it in ticktick — do not propose")
	);
}

// ADR-0042 (as narrowed by ADR-0064): a journal-worthy message that mentions
// People/Projects is recognized as ONE intent graph and proposed as a single
// `apply_intent_graph` — not the old per-entity create-then-reference sequence,
// and no longer gated on a committed Journal Entry. With the Todo retired the
// graph carries Person/Project nodes joined by `journal_ref` links only (the
// todo_project/todo_person link kinds are gone). This guard asserts the shipped
// prompt teaches that contract AND still holds the #179 boundary (a Project is
// an outcome, not a category; the action phrase never becomes a Project name).
// It must also be free of the retired one-at-a-time / JE-accepted-first wording
// so the rewrite can't silently leave both flows in the prompt.
export function teachesIntentGraph(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	const teachesGraph =
		lower.includes("apply_intent_graph") &&
		lower.includes("intent graph") &&
		lower.includes("one proposal") &&
		lower.includes("entities") &&
		lower.includes("links") &&
		lower.includes("journal_ref") &&
		lower.includes("existing_id") &&
		lower.includes("search_entities");
	// The #179 boundary that MUST survive the rewrite.
	const projectBoundary =
		lower.includes("outcome, not a category") &&
		lower.includes("do not turn the action phrase into a");
	// The retired procedural wording the rewrite drops from the JOURNAL
	// extraction flow — the graph is the only multi-entity capture path now.
	const droppedOldFlow =
		!lower.includes("never batch") &&
		!lower.includes("from that accepted journal entry");
	return teachesGraph && projectBoundary && droppedOldFlow;
}

const main = async (): Promise<void> => {
	const lines = stdinLines();
	const manifestLine = await lines.next();
	if (manifestLine === null) return;

	let manifest: PromptManifest = {};
	try {
		manifest = JSON.parse(manifestLine);
	} catch {
		// Fall through to normal reply; malformed manifests are covered elsewhere.
	}

	const prompt = manifest.prompt ?? "";
	const systemPrompt = manifest.workflow?.system_prompt ?? "";
	if (/remember\b.*\bmilk\b/i.test(prompt)) {
		// A boundary-less prompt makes the fixture do the WRONG thing (park a
		// Journal Entry), which is what the e2e guard detects.
		if (!hasReminderBoundary(systemPrompt)) {
			emit({
				kind: "tool_request",
				run_id: "",
				tool_call_id: `tc_${process.pid}`,
				name: "propose_workspace_mutation",
				params: BAD_REMINDER_PROPOSAL,
			});
			await new Promise<void>(() => {});
			return;
		}
		// With the boundary in force, a reminder is a TickTick task Proposal —
		// never a Journal Entry (ADR-0065). Core parks on this call and tears
		// the fixture down, so it must not emit `done`.
		emit({
			kind: "tool_request",
			run_id: "",
			tool_call_id: `tc_${process.pid}`,
			name: "propose_ticktick_task",
			params: {
				payload: { title: "buy milk" },
				rationale: "the user asked to be reminded",
			},
		});
		await new Promise<void>(() => {});
		return;
	}

	emit({
		kind: "text_delta",
		delta:
			"That sounds like a reminder, so I won't save it as a Journal Entry.",
	});
	emit({ kind: "done" });
};

const entryPath = process.argv[1];
if (
	entryPath !== undefined &&
	realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
