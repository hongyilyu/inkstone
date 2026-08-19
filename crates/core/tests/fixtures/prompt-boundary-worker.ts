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
// fail if the model-visible boundary is softened by wording drift. The boundary
// now keeps reminders/tasks OUT of Journal Entries AND redirects them to TickTick
// with NO Workspace mutation (ADR-0064: tasks no longer live in Inkstone) — so
// the guard requires both the exclusion AND the TickTick redirect, not the old
// "drop it silently" or "propose a create_todo" wording.
export function hasReminderBoundary(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	return (
		lower.includes("do not propose a journal entry") &&
		lower.includes("reminders") &&
		lower.includes("tasks") &&
		lower.includes("ticktick is the user's task system") &&
		lower.includes("add it in ticktick") &&
		lower.includes("do not propose any workspace mutation for it")
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
	if (
		/remember\b.*\bmilk\b/i.test(prompt) &&
		!hasReminderBoundary(systemPrompt)
	) {
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
