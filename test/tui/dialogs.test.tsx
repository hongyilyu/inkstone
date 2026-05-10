/**
 * Dialog stack tests.
 *
 * Covers:
 *   - Ctrl+P opens the command palette with expected entries
 *   - ESC closes a dialog without triggering bare-ESC interrupt
 *   - selecting a palette entry runs its onSelect (/clear here)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { FAKE_MODEL, makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("command palette", () => {
	test("Ctrl+P opens palette listing expected entries", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		// Palette is a dialog — title is "Command Panel".
		const f = await waitForFrame(setup, "Command Panel");
		expect(f).toContain("Command Panel");
		// Core palette entries registered by Layout:
		expect(f).toContain("Agents");
		expect(f).toContain("Models");
		expect(f).toContain("Themes");
		expect(f).toContain("Connect");
	});

	test("agent-declared verbs do not appear in the palette", async () => {
		// Per ADR 0006 the palette is program-config-scoped. Agent
		// verbs (Reader's `/article`, KB's `/ingest` / `/lint`) live
		// in the slash dropdown only — they require the user to be
		// in (or commit to) the owning agent, which makes palette
		// browsing irrelevant.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		const f = await waitForFrame(setup, "Command Panel");
		expect(f).not.toContain("/article");
		expect(f).not.toContain("/ingest");
		expect(f).not.toContain("/lint");
	});

	test("ESC closes the palette without aborting anything", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		expect(setup.captureCharFrame()).not.toContain("Command Panel");
		expect(fake.calls.abort).toBe(0);
	});

	test("palette selection runs the entry", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		// DialogSelect focuses its filter input inside a setTimeout(1).
		// Give it a tick before typing — otherwise keystrokes land on the
		// prompt textarea behind the dialog.
		await Bun.sleep(30);

		// Filter to `/clear`. Use `Clear session` verbatim — DialogSelect
		// fuzzy-matches on `title`, so the exact substring puts `Clear
		// session` at index 0 unambiguously.
		await setup.mockInput.typeText("Clear session");
		await waitForFrame(setup, "Clear session");
		// Let the filter effect settle (moveTo is wrapped in setTimeout(0)).
		await Bun.sleep(50);

		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);

		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
	});

	test("Themes entry opens theme dialog; ESC closes without switching", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		await Bun.sleep(30);

		await setup.mockInput.typeText("Themes");
		await waitForFrame(setup, "Themes");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		await waitForFrame(setup, "Select Theme");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		expect(setup.captureCharFrame()).not.toContain("Select Theme");
	});

	test("Models entry opens model dialog; ESC closes without calling setModel", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		await Bun.sleep(30);

		await setup.mockInput.typeText("Models");
		await waitForFrame(setup, "Models");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		// DialogModel title is "Select Model".
		await waitForFrame(setup, "Select Model");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		expect(setup.captureCharFrame()).not.toContain("Select Model");
		expect(fake.calls.setModel).toEqual([]);
	});

	test("Effort palette entry is hidden for non-reasoning models", async () => {
		// Default FAKE_MODEL.reasoning === false, so the registration
		// in app.tsx returns the Effort entry as null. Palette must not
		// show it.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");

		expect(setup.captureCharFrame()).not.toContain("Effort");
	});

	test("Effort entry visible for reasoning model; opens DialogVariant", async () => {
		const reasoningModel = {
			...FAKE_MODEL,
			id: "claude-test-reasoning",
			name: "Claude Test Reasoning",
			reasoning: true,
		};
		const fake = makeFakeSession({ model: reasoningModel });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		// Palette appears with the Effort entry now visible.
		await waitForFrame(setup, "Effort");
		await Bun.sleep(30);

		// Filter to Effort and select.
		await setup.mockInput.typeText("Effort");
		await waitForFrame(setup, "Effort");
		await Bun.sleep(50);

		setup.mockInput.pressEnter();
		// DialogVariant title uses the model name.
		await waitForFrame(setup, /Reasoning effort/);

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		// Nothing changed — no thinkingLevel call.
		expect(fake.calls.setThinkingLevel).toEqual([]);
	});

	test("/config palette entry with no $EDITOR/$VISUAL toasts the path", async () => {
		// Without $EDITOR or $VISUAL set, runEditConfig falls back to
		// "copy path to clipboard + toast the path so the user can
		// open it in any editor." We assert the toast carries the
		// config-file path — the exact tmp path comes from the
		// preload's XDG_CONFIG_HOME setup.
		const prevEditor = process.env.EDITOR;
		const prevVisual = process.env.VISUAL;
		delete process.env.EDITOR;
		delete process.env.VISUAL;
		try {
			const fake = makeFakeSession();
			setup = await renderApp({ session: fake.factory });
			await setup.renderOnce();

			setup.mockInput.pressKey("p", { ctrl: true });
			await waitForFrame(setup, "Command Panel");
			await Bun.sleep(30);
			await setup.mockInput.typeText("Config");
			await waitForFrame(setup, "Config");
			await Bun.sleep(30);
			setup.mockInput.pressEnter();

			// Toast carries the config-file path. The preload places
			// inkstone's config under a tmp dir whose suffix begins
			// with "inkstone-test-"; the toast body includes the full
			// CONFIG_FILE path, so a match on that prefix is enough.
			const f = await waitForFrame(setup, "inkstone-test-");
			expect(f).toContain("Config path copied");
			expect(f).toContain("config.json");
		} finally {
			if (prevEditor !== undefined) process.env.EDITOR = prevEditor;
			if (prevVisual !== undefined) process.env.VISUAL = prevVisual;
		}
	});

	test("open palette suspends Ctrl+N (session list stays closed)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");

		// Press Ctrl+N — normally opens the session list panel. While
		// a dialog is on the stack, DialogProvider's suspend hook
		// blocks global keybind dispatch.
		setup.mockInput.pressKey("n", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);

		// Session list panel header not rendered.
		expect(setup.captureCharFrame()).not.toContain("Sessions ");
	});

	test("Connect dialog renders ✓ for connected providers", async () => {
		// test/preload.ts seeds an OpenRouter API key, so `isConnected()`
		// returns true for OpenRouter in the test runner. That means the
		// Connect dialog's first row carries a `✓` gutter and no
		// `Not configured` description.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		await Bun.sleep(30);

		await setup.mockInput.typeText("Connect");
		await waitForFrame(setup, "Connect");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		const f = await waitForFrame(setup, "Providers");
		expect(f).toContain("✓");
		expect(f).not.toContain("✓ Connected");
		expect(f).not.toContain("Not configured");
	});

	test("Select Model groups rows under provider category header", async () => {
		// DialogModel options carry `category: provider.displayName`,
		// so DialogSelect's grouping pass renders "OpenRouter" as
		// a header line above the OpenRouter model rows.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		await Bun.sleep(30);

		await setup.mockInput.typeText("Models");
		await waitForFrame(setup, "Models");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		const f = await waitForFrame(setup, "OpenRouter");
		// Position check: the category header must land above the
		// first model row. If grouping regressed (e.g. header dropped,
		// or description column re-introduced so "OpenRouter" appears
		// to the right of each row), the substring order flips and
		// this assertion fails. Pull the first-model anchor from
		// pi-ai's live registry (not hardcoded) so a future registry
		// reorder doesn't break a grouping test — only a real grouping
		// regression does. Use the `name` field (what DialogSelect
		// renders), not the `id`.
		const { getModels } = await import("@mariozechner/pi-ai");
		const firstModel = getModels("openrouter")[0];
		expect(firstModel).toBeDefined();
		if (!firstModel) throw new Error("registry empty");
		// DialogSelect may truncate long names, so anchor on the first
		// token (stable across truncation). Registry entries follow
		// "Vendor: Model Name" shape — split on `:` / ` ` / `/` and
		// take the first non-empty chunk.
		const firstToken = firstModel.name
			.split(/[\s:/]+/)
			.find((t) => t.length > 0);
		expect(firstToken).toBeDefined();
		if (!firstToken) throw new Error("first model name has no tokens");
		const headerIdx = f.indexOf("OpenRouter");
		const firstModelIdx = f.indexOf(firstToken);
		expect(headerIdx).toBeGreaterThan(-1);
		expect(firstModelIdx).toBeGreaterThan(headerIdx);
	});

	test("Select Model omits the 'Use default' row when active agent has no override", async () => {
		// Preload's config is `{ vaultDir: VAULT }` only — no per-agent
		// model override. The clear-row should NOT render in this case
		// (it would be a dead UI element with nothing to clear).
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		await Bun.sleep(30);
		await setup.mockInput.typeText("Models");
		await waitForFrame(setup, "Models");
		await Bun.sleep(30);
		setup.mockInput.pressEnter();
		const f = await waitForFrame(setup, "Select Model");

		expect(f).not.toContain("Use default");
	});

	test("Select Model renders 'Use default' row when active agent has a model override", async () => {
		// Seed a per-agent model override on disk before mounting so
		// DialogModel's `loadConfig()` reads it. We restore the
		// preload's config in afterEach to keep downstream tests
		// hermetic.
		const { writeFileSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { CONFIG_HOME } = await import("./../preload");
		const cfgPath = join(CONFIG_HOME, "inkstone", "config.json");
		const original = readFileSync(cfgPath, "utf-8");
		const seeded = JSON.parse(original);
		seeded.agents = {
			reader: {
				model: { providerId: "openrouter", modelId: "fake-override" },
			},
		};
		writeFileSync(cfgPath, JSON.stringify(seeded, null, 2));

		// Drop the in-memory cache so the dialog's `loadConfig()` re-reads
		// the freshly-written file. Otherwise the seeded shape stays
		// invisible until the next process boot.
		const { resetConfigCache } = await import("@backend/persistence/config");
		resetConfigCache();

		try {
			const fake = makeFakeSession();
			setup = await renderApp({ session: fake.factory });
			await setup.renderOnce();

			setup.mockInput.pressKey("p", { ctrl: true });
			await waitForFrame(setup, "Command Panel");
			await Bun.sleep(30);
			await setup.mockInput.typeText("Models");
			await waitForFrame(setup, "Models");
			await Bun.sleep(30);
			setup.mockInput.pressEnter();
			const f = await waitForFrame(setup, "Use default");

			// "Use default" row must be present (override exists). The
			// label format is "Use default (<provider>: <model>)" — we
			// match the prefix only since the resolved-default label
			// depends on what `cfg.model` is at dialog-open time.
			expect(f).toContain("Use default");
		} finally {
			writeFileSync(cfgPath, original);
			resetConfigCache();
		}
	});
});
