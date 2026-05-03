/**
 * Provider-lifecycle regression guards for `AgentProvider`.
 *
 * These cover the side-effects that `AgentProvider` installs at mount
 * and MUST tear down at unmount so a second `renderApp()` in the same
 * process doesn't inherit stale wiring. Failures would manifest as
 * leaks only in test / HMR / future multi-session scenarios; in the
 * shipped single-mount app they stay invisible.
 *
 *   - `agentSession.dispose()` — tears down the pi-agent-core
 *     subscription. Without it the backend Agent holds a strong ref
 *     to the disposed Solid store's event handler, pinning the owner
 *     tree against GC.
 *   - `setConfirmFn` / `setPersistenceErrorHandler` — frontend-owned
 *     module-global handlers. Previously installed without a
 *     cleanup; now capture the prior value and restore it on
 *     unmount.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getConfirmFn } from "../../src/backend/agent";
import { getPersistenceErrorHandler } from "../../src/backend/persistence/errors";
import { makeFakeSession } from "./fake-session";
import { renderApp } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("AgentProvider lifecycle", () => {
	test("dispose() fires on unmount so the backend subscription tears down", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		expect(fake.calls.dispose).toBe(0);

		setup.renderer.destroy();
		setup = undefined;

		// `renderer.destroy()` disposes the Solid owner tree, which
		// fires every `onCleanup` registered under the provider —
		// including the one wired in `provider.tsx` that calls
		// `agentSession.dispose()`. A single dispose is the
		// expectation: the fake's counter flips from 0 to 1.
		expect(fake.calls.dispose).toBe(1);
	});

	test("setConfirmFn + setPersistenceErrorHandler are restored to their prior values on unmount", async () => {
		// Capture the pre-provider state (may be non-null if an earlier
		// test in the process already set one; this test is robust to
		// that). We're asserting restoration, not clearing.
		const confirmBefore = getConfirmFn();
		const persistenceBefore = getPersistenceErrorHandler();

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// While mounted, the provider has overwritten both handlers
		// with its own closures (not necessarily the "before" values).
		// We don't assert what they are — just that unmount restores.
		setup.renderer.destroy();
		setup = undefined;

		expect(getConfirmFn()).toBe(confirmBefore);
		expect(getPersistenceErrorHandler()).toBe(persistenceBefore);
	});
});
