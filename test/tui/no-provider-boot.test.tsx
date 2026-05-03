/**
 * First-boot no-provider fallback tests.
 *
 * When `resolveInitialProviderModel` throws "No provider is connected"
 * on a fresh install, the `ErrorBoundary` around `<AgentProvider>` in
 * `src/tui/app.tsx` should catch it and render `NoProviderFallback`
 * instead of crashing the TUI. These tests use a throwing session
 * factory to simulate the failure without touching the real config —
 * `test/preload.ts` already seeds an OpenRouter key that would
 * otherwise mask the no-provider path.
 *
 * Covers:
 *   - Fallback renders welcome + Ctrl+P hint text on the no-provider throw.
 *   - Ctrl+P opens the palette and lists a single "Connect" entry
 *     registered by the fallback (layout-commands.ts's registration is
 *     unreachable because AgentProvider never mounts).
 *   - Selecting that Connect entry opens the Providers dialog.
 *   - A non-"No provider" throw falls through to the FatalError branch
 *     AND logs to `console.error` so the dev stack isn't silently lost.
 *
 * The zombie-registration concern — that the fallback's Connect entry
 * disposes correctly on `ErrorBoundary.reset()` — relies on Solid's
 * documented owner-disposal contract and isn't exercised here: driving
 * the boundary through a full reset requires completing a real provider
 * login flow, which is out of scope for a regression test. If a zombie
 * ever appears, it will surface as a doubled palette entry in-app.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionFactory } from "../../src/tui/context/agent";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

/**
 * Factory that mirrors what `resolveInitialProviderModel` throws in
 * `src/backend/agent/index.ts:163-165` when no provider is configured.
 * Message prefix `"No provider is connected"` drives the fallback's
 * branch selection.
 */
function throwingNoProviderFactory(): SessionFactory {
	return () => {
		throw new Error(
			"No provider is connected. Open Connect (Ctrl+P → /connect) to sign in to Kiro, ChatGPT, or OpenRouter.",
		);
	};
}

describe("no-provider boot fallback", () => {
	test("renders welcome text + Ctrl+P hint when createSession throws", async () => {
		setup = await renderApp({ session: throwingNoProviderFactory() });
		await setup.renderOnce();

		const f = await waitForFrame(setup, "Welcome to Inkstone");
		expect(f).toContain("Welcome to Inkstone");
		expect(f).toContain("No provider is connected");
		expect(f).toContain("Ctrl+P");
		// `Connect` appears in the hint copy; the palette entry test
		// below verifies it's actually selectable.
		expect(f).toContain("Connect");
	});

	test("Ctrl+P shows a single Connect entry registered by the fallback", async () => {
		setup = await renderApp({ session: throwingNoProviderFactory() });
		await setup.renderOnce();
		await waitForFrame(setup, "Welcome to Inkstone");

		setup.mockInput.pressKey("p", { ctrl: true });
		const f = await waitForFrame(setup, "Command Panel");
		expect(f).toContain("Connect");
		// AgentProvider never mounted, so `layout-commands.ts`'s entries
		// (Agents, Models, Themes, Clear session) must NOT appear — only
		// the fallback's single Connect entry.
		expect(f).not.toContain("Clear session");
		expect(f).not.toContain("Models");
		expect(f).not.toContain("Themes");
	});

	test("selecting Connect opens the Providers dialog", async () => {
		setup = await renderApp({ session: throwingNoProviderFactory() });
		await setup.renderOnce();
		await waitForFrame(setup, "Welcome to Inkstone");

		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");
		// DialogSelect focuses its filter input inside a setTimeout(1);
		// same 30ms idiom as `dialogs.test.tsx` and `connect-manage.test.tsx`.
		await Bun.sleep(30);

		// Only one entry is registered, so Enter lands on it without
		// filtering. Still type "Connect" to mirror the user flow and
		// assert the title is present in the filtered view.
		await setup.mockInput.typeText("Connect");
		await waitForFrame(setup, "Connect");
		setup.mockInput.pressEnter();

		// DialogProviderSelect's title is "Providers".
		const f = await waitForFrame(setup, "Providers");
		expect(f).toContain("Providers");
	});

	test("unexpected errors render the fatal-error line, not the Connect flow", async () => {
		const factory: SessionFactory = () => {
			throw new Error("boom: corrupted state");
		};
		// Suppress + assert the FatalError branch's `console.error` call
		// so (a) the raw Solid stack doesn't pollute CI output and
		// (b) the dev-stack-preservation contract stays pinned — if a
		// future refactor drops the log, this assertion fails.
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			setup = await renderApp({ session: factory });
			await setup.renderOnce();

			const f = await waitForFrame(setup, "Fatal error");
			expect(f).toContain("Fatal error");
			expect(f).toContain("boom: corrupted state");
			// Crucially, the Connect copy is NOT shown — unknown errors
			// don't offer a provider-pick affordance.
			expect(f).not.toContain("Welcome to Inkstone");
			expect(f).not.toContain("Ctrl+P");
			// Dev stack preserved via console.error — pins the contract
			// documented in `no-provider-fallback.tsx`'s FatalError.
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
