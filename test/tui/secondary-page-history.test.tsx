/**
 * Browser-style back/forward gestures (Ctrl+[ / Ctrl+]) for the
 * secondary page. Pins the invariants in ADR 0017. Per-session
 * isolation is covered in `secondary-page-per-session.test.tsx`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetSecondaryPageForTesting,
	openSecondaryPage,
} from "../../src/tui/context/secondary-page";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	__resetSecondaryPageForTesting();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("secondary page history", () => {
	test("Ctrl+[ then Ctrl+] round-trips back to the same page", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a turn so a session id exists (history is per-session).
		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({ content: "# Round Trip Page", title: "rt" });
		await waitForFrame(setup, "Round Trip Page");

		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Round Trip Page");

		setup.mockInput.pressKey("]", { ctrl: true });
		await waitForFrame(setup, "Round Trip Page");
	});

	test("Ctrl+] is a no-op when forward stack is empty", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({ content: "# Forward Empty Page", title: "fe" });
		await waitForFrame(setup, "Forward Empty Page");

		setup.mockInput.pressKey("]", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("Forward Empty Page");
	});

	test("opening a new page clears the forward stack (browser rule 1)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// Open A → step back → forward holds A. Open B (rule 1 wipes
		// forward) → Ctrl+] must NOT time-travel back to A.
		openSecondaryPage({ content: "# Page A Content", title: "a" });
		await waitForFrame(setup, "Page A Content");
		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);

		openSecondaryPage({ content: "# Page B Content", title: "b" });
		await waitForFrame(setup, "Page B Content");

		setup.mockInput.pressKey("]", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		const f = setup.captureCharFrame();
		expect(f).toContain("Page B Content");
		expect(f).not.toContain("Page A Content");
	});

	test("conversation is the floor of the back stack — never pushed as a phantom entry", async () => {
		// Regression guard: without the "skip pushing null current"
		// rule in `navigateTo`, the sequence below would leave a
		// phantom `null` entry on `back`, and the second Ctrl+[ from
		// conversation would pop it instead of no-op'ing — corrupting
		// the forward stack. The final Ctrl+] verifies forward still
		// holds B (a phantom pop would have shifted B out).
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({ content: "# Floor Test A", title: "a" });
		await waitForFrame(setup, "Floor Test A");
		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		openSecondaryPage({ content: "# Floor Test B", title: "b" });
		await waitForFrame(setup, "Floor Test B");

		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Floor Test B");

		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		setup.mockInput.pressKey("]", { ctrl: true });
		await waitForFrame(setup, "Floor Test B");
	});
});
