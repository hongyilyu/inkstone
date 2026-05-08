/**
 * Knowledge Base agent slash commands — TUI happy paths.
 *
 * Existing coverage: `test/knowledge-base-agent.test.ts` exercises the
 * registry / zone / permission shape at unit level; `agent-cycle.test.tsx`
 * proves Tab cycles to the KB agent and `/article` falls through on it.
 * Neither runs a full slash dispatch through the TUI for KB-owned verbs.
 *
 * What this file pins:
 *   - `/ingest` (no-args): dispatches a single prompt with the canned
 *     "Run the ingest workflow." string from `agents/knowledge-base/index.ts`.
 *   - `/lint` (no-args): same shape with "Run the lint workflow.".
 *   - `/query` (takesArgs: true): typed args land in the prompt body
 *     ("Run the query workflow.\n\nQuestion: <args>"). Empty args
 *     get rejected by `canRunSlashEntry` and fall through as plain prompt.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

/**
 * Cycle from the default Reader agent to Knowledge Base on the open page.
 * Tab on `OpenPage` rotates `store.currentAgent`. The agent registry
 * order is `reader` → `knowledge-base`, so one Tab is enough.
 */
async function cycleToKnowledgeBase(s: NonNullable<typeof setup>) {
	// Confirm we start on Reader. The open-page footer shows the
	// active agent's displayName.
	await waitForFrame(s, "Reader");
	s.mockInput.pressTab();
	await waitForFrame(s, "Knowledge Base");
}

describe("knowledge-base slash commands", () => {
	test("/ingest dispatches the ingest workflow prompt", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await cycleToKnowledgeBase(setup);

		// Trailing space dismisses the autocomplete dropdown so Enter
		// reaches `submit-prompt` rather than re-inserting "/ingest "
		// into the textarea via the dropdown's onSelect (same UX path
		// as `/article ` — see reader-article.test.tsx).
		await setup.mockInput.typeText("/ingest ");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("Run the ingest workflow.");
	});

	test("/lint dispatches the lint workflow prompt", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await cycleToKnowledgeBase(setup);

		await setup.mockInput.typeText("/lint ");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("Run the lint workflow.");
	});

	test("/query <question> embeds the args into the workflow prompt", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await cycleToKnowledgeBase(setup);

		// `/query` has `takesArgs: true` — `canRunSlash` requires
		// non-empty args. Type the verb + space + a question.
		await setup.mockInput.typeText("/query what is foo");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		expect(fake.calls.prompt.length).toBe(1);
		const sent = fake.calls.prompt[0];
		expect(sent).toBeDefined();
		if (!sent) return;
		// Format mirrors `queryCommand.execute` in
		// `src/backend/agent/agents/knowledge-base/index.ts`.
		expect(sent).toBe("Run the query workflow.\n\nQuestion: what is foo");
	});

	test("bare /query (no args) falls through as plain prompt", async () => {
		// `canRunSlashEntry({ takesArgs: true }, "")` returns false, so
		// `triggerSlash` returns false and `submit-prompt` falls through
		// to the plain-prompt branch with the literal "/query" text.
		// Pins the contract: KB's argful command can't accidentally
		// fire on a bare verb with empty args.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await cycleToKnowledgeBase(setup);

		await setup.mockInput.typeText("/query ");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// Falls through with the trailing space stripped on the
		// plain-prompt path. `buildSubmission` calls `buildMentionPayload`
		// which preserves the original text (no trim), so we expect the
		// raw "/query " literal in the prompt call.
		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("/query ");
	});
});
