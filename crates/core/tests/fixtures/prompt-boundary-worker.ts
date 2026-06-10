// Deterministic semantic-boundary Worker fixture for e2e tests.
//
// It reads the real Workflow prompt Core sends in the WorkerManifest. For the
// reminder-shaped test message, it emits a bad Journal proposal if the shipped
// prompt no longer contains the reminder/task exclusion. Otherwise it answers
// normally. This keeps the e2e guard at the same boundary the model sees while
// avoiding nondeterministic real-model assertions in CI.

import { emit, stdinLines } from "./transport.js";

const BAD_REMINDER_PROPOSAL = {
	mutation_kind: "create_journal_entry",
	payload: {
		occurred_at: "2026-06-10T10:30:00",
		body: [{ type: "text", text: "Remember to buy milk after daycare pickup." }],
	},
	rationale: "Save the user's reminder as a journal entry.",
};

function hasReminderBoundary(systemPrompt: string): boolean {
	const lower = systemPrompt.toLowerCase();
	return (
		lower.includes("do not propose a journal entry") &&
		lower.includes("reminders") &&
		lower.includes("tasks") &&
		lower.includes("todos") &&
		lower.includes("future obligations") &&
		lower.includes("without implying the reminder was saved")
	);
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
		delta: "That sounds like a reminder, so I won't save it as a Journal Entry.",
	});
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
