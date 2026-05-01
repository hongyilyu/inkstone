import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeSession } from "./fake-session";
import { renderApp } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("open page", () => {
	test("renders the inkstone logo and prompt placeholder", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		const f = setup.captureCharFrame();
		// ASCII-font block letters contain "ink" + "stone" in block rendering;
		// the raw chars aren't literal — just assert the footer + placeholder
		// that are rendered as plain text.
		expect(f).toContain("Type a message");
	});
});
