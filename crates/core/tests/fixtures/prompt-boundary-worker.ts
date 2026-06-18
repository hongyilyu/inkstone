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
// now keeps reminders/tasks OUT of Journal Entries AND routes them to a direct
// create_todo sourced from the user Message — so the guard requires both the
// exclusion AND the redirect, not the old "drop it silently" wording.
export function hasReminderBoundary(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	return (
		lower.includes("do not propose a journal entry") &&
		lower.includes("reminders") &&
		lower.includes("tasks") &&
		lower.includes("todos") &&
		lower.includes("future obligations") &&
		lower.includes("create_todo") &&
		lower.includes("do not create a journal entry first")
	);
}

// ADR-0042: a journal-worthy message that mentions People/Projects/actions is
// recognized as ONE intent graph and proposed as a single `apply_intent_graph`
// — not the old per-entity create-then-reference sequence, and no longer gated
// on a committed Journal Entry. This guard asserts the shipped prompt teaches
// that contract: one proposal carrying entity nodes + the three link kinds, the
// Todo→Project relationship expressed as a LINK (not a field), AND that it still
// holds the #179 boundary (a Project is an outcome, not a category; the action
// phrase never becomes a Project name). It must also be free of the retired
// one-at-a-time / two-step-reference / JE-accepted-first wording so the rewrite
// can't silently leave both flows in the prompt.
export function teachesIntentGraph(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	const teachesGraph =
		lower.includes("apply_intent_graph") &&
		lower.includes("intent graph") &&
		lower.includes("one proposal") &&
		lower.includes("entities") &&
		lower.includes("links") &&
		lower.includes("todo_project") &&
		lower.includes("todo_person") &&
		lower.includes("journal_ref") &&
		lower.includes("existing_id") &&
		lower.includes("search_entities");
	// The Todo's owning Project is a link, never a field on the todo node.
	const projectViaLink =
		lower.includes("todo_project link") && lower.includes("not a field");
	// The #179 boundary that MUST survive the rewrite.
	const projectBoundary =
		lower.includes("outcome, not a category") &&
		lower.includes("do not turn the action phrase into a");
	// The retired procedural wording the rewrite drops from the JOURNAL
	// extraction flow. (The direct-Todo enrichment flow is unchanged by ADR-0042
	// and may keep "one mutation at a time" / "once that create is accepted", so
	// those phrases are NOT asserted-absent here. Only the wording UNIQUE to the
	// removed journal-extraction sequencing is.)
	const droppedOldFlow =
		!lower.includes("never batch") &&
		!lower.includes("from that accepted journal entry");
	return teachesGraph && projectViaLink && projectBoundary && droppedOldFlow;
}

const main = async (): Promise<void> => {
	const lines = stdinLines();
	const manifestLine = await lines.next();
	if (manifestLine === null) return;

	let manifest: {
		prompt?: string;
		workflow?: { system_prompt?: string };
	} = {};
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
