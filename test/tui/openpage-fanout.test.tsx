/**
 * Open-page autocomplete fan-out across agent verbs.
 *
 * Per ADR 0006 ("before commitment, the open-page autocomplete shows
 * every agent's verbs") and ADR 0007 ("slash commands and explicit Tab
 * picks bypass the router entirely because they ARE the classification"),
 * the slash dropdown on the open page must list every non-router agent's
 * verbs while bound to the default router with no messages yet. Once
 * Tab-pick or message-send commits the session to a specific agent, the
 * dropdown collapses to that agent's verbs only.
 *
 * Pinning here so a regression to the pre-fan-out single-agent behavior
 * fails loudly. Slash-pick auto-commit is pinned in PR 3.
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

describe("open-page slash fan-out", () => {
	test("dropdown lists every non-router agent's verbs while bound to router", async () => {
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await waitForFrame(setup, "Router");

		await setup.mockInput.typeText("/");
		const f = await waitForFrame(setup, "/article");
		// Reader's `/article`, KB's `/ingest` / `/lint` / `/query`.
		expect(f).toContain("/article");
		expect(f).toContain("/ingest");
		expect(f).toContain("/lint");
		expect(f).toContain("/query");
		// Shell verb is unaffected.
		expect(f).toContain("/clear");
	});

	test("slash-pick from router auto-commits to the owning agent", async () => {
		// Per ADR 0007 ("slash commands and explicit Tab picks bypass
		// the router entirely because they ARE the classification"),
		// typing `/article foo.md` while bound to the router must
		// commit the session to Reader BEFORE running the verb — not
		// fall through to a plain prompt that the router then LLM-
		// classifies. This is the contract that's broken in isolation
		// at the end of PR 2.
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await waitForFrame(setup, "Router");

		// `/article` is reader's verb; `foo.md` is preloaded under
		// `010 RAW/013 Articles/` (see test/preload.ts).
		await setup.mockInput.typeText("/article foo.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// The bridge auto-committed to Reader before invoking execute.
		expect(fake.calls.selectAgent).toContain("reader");
		// And the command actually ran — prompt carries the article
		// workflow text, not the literal `/article foo.md`.
		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toContain(
			"Read this article and begin the reading workflow.",
		);
		expect(fake.calls.prompt[0]).toContain("foo.md");
	});

	test("after Tab to Reader the dropdown collapses to Reader's verbs", async () => {
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await waitForFrame(setup, "Router");

		setup.mockInput.pressTab();
		await waitForFrame(setup, "Reader");

		await setup.mockInput.typeText("/");
		const f = await waitForFrame(setup, "/article");
		expect(f).toContain("/article");
		expect(f).toContain("/clear");
		// KB verbs are gone — fan-out collapsed.
		expect(f).not.toContain("/ingest");
		expect(f).not.toContain("/lint");
		expect(f).not.toContain("/query");
	});
});
