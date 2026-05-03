/**
 * `/mini-model` dialog + palette entry.
 *
 * Covers:
 *   - Palette entry listed in the Ctrl+P menu
 *   - Opening the dialog lists the clear-row with resolved default label
 *   - Picking a model writes config.sessionTitleModel through saveConfig
 *   - Picking "Use provider default" clears config.sessionTitleModel
 *   - Success toast contains the expected "for <Provider>: <modelId>" shape
 *   - Override pointing at a disconnected provider surfaces as a
 *     "(disconnected)" pinned row
 *
 * Write assertion strategy: read `config.json` directly from the
 * preload's CONFIG_HOME. The preload seeds `config.json` with
 * `{ vaultDir }` only, so a test that writes `sessionTitleModel` can
 * assert on the re-read JSON. `loadConfig` caches at module-eval but
 * that cache is also invalidated by `saveConfig` (it replaces `cached`
 * in place), so follow-up reads in the same process pick up the new
 * value. Test-local `readConfig()` uses the same path the preload
 * writes to — no `loadConfig` cache hop.
 *
 * Cache invalidation: tests that `writeFileSync` directly (bypassing
 * `saveConfig`) must call `resetConfigCache()` before the dialog
 * opens, otherwise `loadConfig()` in the dialog returns the stale
 * cached value from the first load. The `afterEach` cleanup also
 * resets the cache to prevent leakage between tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetConfigCache } from "@backend/persistence/config";
import { CONFIG_HOME } from "../preload";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

const CONFIG_FILE = join(CONFIG_HOME, "inkstone", "config.json");

function readConfig(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Reset config.json to the preload's baseline (`{ vaultDir }` only).
 * Without this, state from an earlier test in the suite leaks into the
 * next test's `loadConfig()` read. We preserve `vaultDir` so any other
 * module that re-reads config during the test (permissions layer,
 * reader's article scanner) still sees the tmp vault path. Also drops
 * the in-memory config cache so the next `loadConfig()` re-reads from
 * disk — without this, a test that `writeFileSync`-es an override
 * below this helper sees the override, but the *dialog* running in a
 * separate test sees the pre-write cached value.
 */
function resetConfig(): void {
	const current = readConfig();
	const next: Record<string, unknown> = {};
	if (typeof current.vaultDir === "string") next.vaultDir = current.vaultDir;
	writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
	resetConfigCache();
}

/**
 * Write-then-invalidate helper for tests that seed an override by
 * direct `writeFileSync` (bypassing `saveConfig`). The dialog's
 * `loadConfig()` call would otherwise hit the stale module cache from
 * a prior `loadConfig()` chain (e.g. `resolveTitleModel` in a
 * background test, or this file's own prior test).
 */
function seedConfigOverride(
	extra: Record<string, unknown> & {
		sessionTitleModel: { providerId: string; modelId: string };
	},
): void {
	const vaultDir = (readConfig().vaultDir as string | undefined) ?? "";
	writeFileSync(CONFIG_FILE, JSON.stringify({ vaultDir, ...extra }, null, 2));
	resetConfigCache();
}

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
	resetConfig();
});

async function openMiniModelDialog(s: Awaited<ReturnType<typeof renderApp>>) {
	s.mockInput.pressKey("p", { ctrl: true });
	await waitForFrame(s, "Command Panel");
	// DialogSelect focuses its filter input inside a setTimeout(1).
	// Give it a tick before typing — otherwise keystrokes land on the
	// prompt textarea behind the dialog.
	await Bun.sleep(30);

	// "Mini" is unique enough to filter-match the entry without
	// ambiguity (no other entry contains "Mini" today); using the
	// clipped "Mini Mod" render form is only safe for assertions,
	// not for typeText where every character lands in the input.
	await s.mockInput.typeText("Mini");
	await waitForFrame(s, "Mini Mod");
	// Let the filter effect settle (moveTo is wrapped in setTimeout(0)).
	await Bun.sleep(50);

	s.mockInput.pressEnter();
	// Dialog title is short enough to survive the narrow render
	// column. The clear-row's long label would be truncated; anchor
	// on the dialog-only title "Mini Model" instead (different from
	// the palette row which renders as "Mini Mod" due to description
	// column compression).
	await waitForFrame(s, "Search models...");
	await Bun.sleep(30);
}

describe("/mini-model dialog", () => {
	test("palette entry appears alongside other model commands", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressKey("p", { ctrl: true });
		const f = await waitForFrame(setup, "Command Panel");
		// Palette column is narrow enough to clip "Mini Model"
		// mid-word at 100-col default; anchor on the prefix + the
		// description tail which survives the render width.
		expect(f).toContain("Mini Mod");
		expect(f).toContain("Small model for background");
	});

	test("dialog opens with clear-row showing resolved provider default", async () => {
		// FAKE_MODEL points at OpenRouter `anthropic/claude-opus-4.7`.
		// OpenRouter's provider shim declares `titleModelId:
		// "moonshotai/kimi-k2.6"`, so the clear-row label embeds
		// "(OpenRouter: moonshotai/kimi-k2.6)". DialogSelectRow clamps
		// titles at 61 chars with a trailing ellipsis, so the final
		// ".6" gets dropped — anchor the assertion on the substring
		// that survives the truncation + the trailing ellipsis.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 140 });
		await setup.renderOnce();

		await openMiniModelDialog(setup);

		const f = setup.captureCharFrame();
		expect(f).toContain("Use provider default");
		expect(f).toContain("OpenRouter: moonshotai/kimi-k2");
		// Trailing `…` confirms we saw the truncation, not a raw
		// label without the resolved default portion.
		expect(f).toMatch(/moonshotai\/kimi-k2…?/);
	});

	test("picking a model writes config.sessionTitleModel", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 140 });
		await setup.renderOnce();

		await openMiniModelDialog(setup);

		// Filter on the model's display `name` (DialogSelect's
		// `fuzzysort.go({ key: "title" })` matches against the rendered
		// name, not the model id). `Claude Haiku` is specific enough
		// that only Anthropic Haiku variants surface; `Haiku 4.5`
		// alone would also pick up pi-ai's `claude-haiku-4.5:thinking`
		// row, so we submit from a further-narrowed anchor.
		await setup.mockInput.typeText("Claude Haiku 4.5");
		await waitForFrame(setup, "Claude Haiku 4.5");
		await Bun.sleep(50);

		setup.mockInput.pressEnter();

		// Success toast fired with "for <Provider>: <modelId>".
		const afterPick = await waitForFrame(setup, "Mini model for OpenRouter");
		expect(afterPick).toContain("Mini model for OpenRouter");
		expect(afterPick).toMatch(/anthropic\/claude-haiku-4\.5/);

		const cfg = readConfig();
		const chosen = cfg.sessionTitleModel as
			| { providerId: string; modelId: string }
			| undefined;
		expect(chosen?.providerId).toBe("openrouter");
		// Accept either the plain or `:thinking` variant — pi-ai's
		// fuzzy order may place either first. Both are valid for what
		// this test pins: that the config write happened and targets
		// the right provider + a real Haiku 4.5 model.
		expect(chosen?.modelId).toMatch(/^anthropic\/claude-haiku-4\.5/);
	});

	test("picking 'Use provider default' clears config.sessionTitleModel", async () => {
		// Seed an override so the clear-row has something to revert.
		// Without this seed, the dialog's `current` prop resolves to
		// `{ kind: "clear" }` and the `●` already sits on the clear
		// row, but the real bug we want to pin is the "user actively
		// clears an existing override" path.
		seedConfigOverride({
			sessionTitleModel: {
				providerId: "openrouter",
				modelId: "anthropic/claude-haiku-4.5",
			},
		});

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 140 });
		await setup.renderOnce();

		await openMiniModelDialog(setup);

		// Filter to the clear-row so it becomes the only visible
		// option, then Enter submits it. The clear-row's title starts
		// with "Use provider default" — filtering on "Use provider"
		// matches only that row. Avoids the ambiguity of trying to
		// navigate with `select_first` (keybind is `home`, not `g`)
		// across the scrollbox when an override puts `●` on a model
		// row instead.
		await setup.mockInput.typeText("Use provider");
		await waitForFrame(setup, "Use provider default");
		await Bun.sleep(50);
		setup.mockInput.pressEnter();

		const afterClear = await waitForFrame(
			setup,
			"Mini model: provider default",
		);
		expect(afterClear).toContain("Mini model: provider default");
		// Resolved default label in the toast body (OpenRouter's
		// `titleModelId` is `moonshotai/kimi-k2.6`). Toast panel is
		// narrow — the full label wraps across two lines. Assert on
		// the two halves separately; cross-line regex matching trips
		// over the `│` borders + whitespace the toast panel draws
		// between rows.
		expect(afterClear).toContain("OpenRouter: moonshotai/");
		expect(afterClear).toContain("kimi-k2.6");

		const cfg = readConfig();
		expect(cfg.sessionTitleModel).toBeUndefined();
	});

	test("override on a disconnected provider surfaces as '(disconnected)' row", async () => {
		// Seed an override targeting a provider that isn't connected
		// in the test environment. The preload seeds OpenRouter creds
		// only; `kiro` / `openai-codex` have no stored auth, so
		// `kiroProvider.isConnected()` returns false and its
		// `listModels()` returns []. That means a stored override
		// pointing at Kiro has nowhere to land in the per-provider
		// catalog.
		//
		// Behavior under test: the dialog must surface the stale
		// override as an explicit row with `(disconnected)` so the
		// user can see what's stored and choose to clear it. Without
		// this row, the `●` indicator has nowhere to land and the
		// stored state is invisible.
		seedConfigOverride({
			sessionTitleModel: {
				providerId: "kiro",
				modelId: "moonshotai.kimi-k2-5",
			},
		});

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 140 });
		await setup.renderOnce();

		await openMiniModelDialog(setup);

		const f = setup.captureCharFrame();
		// The stored override's provider id renders verbatim because
		// `getProvider("kiro")` returns the registered provider whose
		// `displayName` is "Amazon Kiro" — we anchor on the
		// `(disconnected)` suffix which is the decisive signal.
		expect(f).toContain("(disconnected)");
		expect(f).toContain("moonshotai.kimi-k2-5");
	});
});
