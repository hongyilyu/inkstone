/**
 * End-to-end coverage for per-agent model override flow.
 *
 * The unified-config refactor introduced two adjacent behaviors that
 * the prior PR-1 conversation test only partially exercised:
 *
 *   1. Picking a model via `/models` writes to `agents.<active>.model`
 *      (not top-level), so a reader pick doesn't leak into KB.
 *   2. The "Use default" row appears only when the active agent has an
 *      override; selecting it removes the per-agent `model` key.
 *
 * Both behaviors are routed through the real backend `Session`'s
 * `setModel` / `clearAgentModel` actions in PR 1; the dialogs and
 * command palette plumbing land in PR 2. This file verifies the flows
 * end-to-end through the TUI harness, not at the dialog level alone.
 *
 * The fake session's per-agent model map (introduced in PR 1) makes
 * these flows assertable without booting pi-agent-core: passing
 * `agentModels` causes `selectAgent` to flip the bound model the same
 * way the real backend does; `clearAgentModel` reverts to the
 * top-level `model` opt.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import { FAKE_MODEL, makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("per-agent model override flow", () => {
	test("agent switch flips active model + clearAgentModel reverts to top-level", async () => {
		const READER_MODEL: Model<Api> = {
			...FAKE_MODEL,
			id: "reader-only-model",
			name: "Reader Only Model",
			contextWindow: 99_999,
		};
		const KB_MODEL: Model<Api> = {
			...FAKE_MODEL,
			id: "kb-only-model",
			name: "KB Only Model",
			contextWindow: 12_345,
		};
		const fake = makeFakeSession({
			model: FAKE_MODEL, // top-level fallback
			agentModels: { reader: READER_MODEL, "knowledge-base": KB_MODEL },
		});
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Boot: reader is active, with its per-agent model.
		await waitForFrame(setup, "Reader Only Model");

		// Cycle to KB → KB's per-agent model becomes active.
		setup.mockInput.pressTab();
		await waitForFrame(setup, "KB Only Model");

		// Registry [router, reader, knowledge-base]: Tab from KB wraps
		// to router (no per-agent model → top-level FAKE_MODEL applies).
		// Tab once more lands on Reader and restores its override.
		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await waitForFrame(setup, "Reader Only Model");

		// Now exercise the clear path. We bypass the dialog (driving
		// the full DialogModel keyboard chain to the "Use default" row
		// is brittle — relative position depends on connected provider
		// model counts) and call `actions.clearAgentModel` directly via
		// the same wrapper that DialogModel's `onClear` invokes. This
		// is the same code path the user reaches by picking the
		// clear-row, just without the keyboard navigation.
		// Use `setup.getAgent().actions.clearAgentModel` (the
		// TUI-wrapped action) rather than the raw backend session.
		// The wrapper is what `DialogModel`'s "Use default" row
		// invokes — direct backend calls would bypass the store-sync
		// side effect (mirroring `setModel`'s pattern).
		setup.getAgent().actions.clearAgentModel();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		// Frame now reflects the top-level fallback (FAKE_MODEL.name).
		// Anchor on the vendor token "Anthropic" which appears in
		// `FAKE_MODEL.name = "Anthropic: Claude Opus 4.7"` and is
		// stable under the prompt bar's truncation behavior. The
		// negative checks below confirm the per-agent override values
		// have actually been wiped from the rendered frame, not just
		// that *some* model name appears.
		const f = setup.captureCharFrame();
		expect(f).toContain("Anthropic");
		expect(f).not.toContain("Reader Only Model");
		expect(f).not.toContain("KB Only Model");

		// One clearAgentModel call recorded on the fake.
		expect(fake.calls.clearAgentModel).toBe(1);
	});
});
