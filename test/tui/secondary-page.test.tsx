/**
 * Secondary page open/close flow.
 *
 * The secondary page replaces the conversation area with a full-screen
 * markdown renderer. Opened by clicking a file chip (or programmatically
 * via `openSecondaryPage`); closed via the `secondary_page_close`
 * keybind (ESC / Ctrl+[) or the back button in the sidebar.
 *
 * We use `openSecondaryPage` directly rather than simulating a click —
 * OpenTUI's `captureCharFrame` doesn't expose hit-testing, and the
 * click wiring itself is tested at the util layer
 * (`util/file-part-handler.ts` routes through this function regardless
 * of the caller).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSecondaryPage,
	openSecondaryPage,
} from "../../src/tui/context/secondary-page";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	// Always close any secondary page left open by a failing test so
	// the module-level signal doesn't leak across cases.
	closeSecondaryPage();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("secondary page", () => {
	test("openSecondaryPage renders content; ESC closes", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a turn so the non-open-page layout is active (the
		// SecondaryPage mounts inside the conversation branch of the
		// Layout).
		await setup.mockInput.typeText("hello");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({
			content: "# Article Title\n\nBody paragraph.",
			title: "article",
		});
		await waitForFrame(setup, "Article Title");

		// Back button is visible in the sidebar.
		expect(setup.captureCharFrame()).toContain("← Back");

		// ESC closes.
		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Article Title");
	});

	test("Ctrl+[ also closes the secondary page", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("prime");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({ content: "# Second Page" });
		await waitForFrame(setup, "Second Page");

		setup.mockInput.pressKey("[", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Second Page");
	});

	test("format: 'text' renders content verbatim without markdown parsing", async () => {
		// Plain-text format bypasses the markdown renderer so content
		// like `# not a heading` or raw log output appears literally.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("prime");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({
			content: "# not a heading\n* not a bullet",
			format: "text",
		});
		await waitForFrame(setup, "# not a heading");

		// Literal `#` survives — the markdown renderer would have
		// consumed it as a heading marker and stripped the `#` glyph.
		const f = setup.captureCharFrame();
		expect(f).toContain("# not a heading");
		expect(f).toContain("* not a bullet");
	});

	test("ESC with an open dialog over a secondary page closes the dialog, not the page", async () => {
		// app.tsx's secondary_page_close handler is gated on
		// `dialog.stack.length === 0` — so an open dialog wins the ESC.
		// This pins that routing: dialog closes, secondary page stays.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a turn so the conversation layout is active.
		await setup.mockInput.typeText("prime");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// Open the secondary page.
		openSecondaryPage({ content: "# Page Still Here" });
		await waitForFrame(setup, "Page Still Here");

		// Open the command palette on top.
		setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(setup, "Command Panel");

		// ESC: dialog closes, page remains.
		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		const f = setup.captureCharFrame();
		expect(f).not.toContain("Command Panel");
		expect(f).toContain("Page Still Here");
	});
});
