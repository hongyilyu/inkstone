/**
 * Test harness for the Inkstone TUI.
 *
 * Mounts the same provider stack as `App` (ThemeProvider → ToastProvider
 * → DialogProvider → CommandProvider → AgentProvider → Layout), but
 * with an injected `session` factory so tests can script AgentEvents
 * without a real pi-agent-core loop.
 */

import { testRender } from "@opentui/solid";
import type { generateSessionTitle } from "../../src/backend/agent";
import { Layout } from "../../src/tui/app";
import { CommandProvider } from "../../src/tui/components/dialog/command";
import type { SessionFactory } from "../../src/tui/context/agent";
import { AgentProvider } from "../../src/tui/context/agent";
import { ThemeProvider } from "../../src/tui/context/theme";
import { DialogProvider } from "../../src/tui/ui/dialog";
import { ToastProvider } from "../../src/tui/ui/toast";

export interface HarnessOptions {
	session: SessionFactory;
	sessionTitleGenerator?: typeof generateSessionTitle;
	width?: number;
	height?: number;
}

export async function renderApp(opts: HarnessOptions) {
	const width = opts.width ?? 100;
	const height = opts.height ?? 30;
	return testRender(
		() => (
			<ThemeProvider>
				<ToastProvider>
					<DialogProvider>
						<CommandProvider>
							<AgentProvider
								session={opts.session}
								sessionTitleGenerator={
									opts.sessionTitleGenerator ?? (async () => null)
								}
							>
								<Layout />
							</AgentProvider>
						</CommandProvider>
					</DialogProvider>
				</ToastProvider>
			</ThemeProvider>
		),
		{ width, height },
	);
}

/** Wait until `fn()` returns true, or throw after `timeout` ms. */
export async function waitUntil(
	fn: () => boolean,
	opts: { timeout?: number; message?: string } = {},
): Promise<void> {
	const timeout = opts.timeout ?? 2000;
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeout) {
			throw new Error(opts.message ?? "waitUntil timed out");
		}
		await Bun.sleep(10);
	}
}

/**
 * Wait for the rendered frame to contain `needle`. Markdown rendering
 * is async (tree-sitter highlighting happens on a worker), so a single
 * `renderOnce()` after mutating store state is rarely enough. This
 * polls `renderOnce + captureCharFrame` until the needle appears or
 * the timeout fires.
 */
export async function waitForFrame(
	setup: {
		renderOnce: () => Promise<void>;
		captureCharFrame: () => string;
	},
	needle: string | RegExp,
	opts: { timeout?: number } = {},
): Promise<string> {
	// 3s default instead of 2s — gives CI fs operations (vault walk,
	// tree-sitter worker warmup) enough slack without rewriting every
	// test site. Tests that already bump higher keep their override.
	const timeout = opts.timeout ?? 3000;
	const start = Date.now();
	const matches = (f: string) =>
		typeof needle === "string" ? f.includes(needle) : needle.test(f);
	while (Date.now() - start < timeout) {
		await setup.renderOnce();
		const f = setup.captureCharFrame();
		if (matches(f)) return f;
		await Bun.sleep(25);
	}
	const final = setup.captureCharFrame();
	throw new Error(
		`waitForFrame: ${needle} not found within ${timeout}ms\n---\n${final}\n---`,
	);
}
